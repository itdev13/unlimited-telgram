const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');
const Installation = require('../schemas/installation.schema');
const Phone = require('../schemas/phone.schema');
const PhoneAuthSession = require('../schemas/phone-auth-session.schema');
const PendingUpdate = require('../schemas/pending-update.schema');
const { MessageLog, MessageDirection, MessageStatus } = require('../schemas/message-log.schema');
const { persistAttachment, mediaCategory, extFromMime } = require('../media/media-store');
const { extractContactInfo } = require('../utils/contact-extract');
const { TRIGGERS } = require('../workflows/trigger-keys');

/**
 * v2 MULTI-PHONE: phone auth now writes Phone documents (collection `phones`) instead of
 * Installation.phoneConfig, and the GramJS client pool is keyed by the Phone's _id
 * (connectionId). Many phones per location. Inbound ALWAYS syncs — there is no billing
 * gate (v2 is subscription-based; inbound is never blocked so we never lose messages).
 */
class GramJsService {
  constructor(connectionManager, cryptoService, ghlService, contactMappingService, telegramService, workflowsService) {
    this.connectionManager = connectionManager;
    this.crypto = cryptoService;
    this.ghlService = ghlService;
    this.contactMapping = contactMappingService;
    this.telegramService = telegramService;
    this.workflows = workflowsService;

    const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
    const apiHash = process.env.TELEGRAM_API_HASH;
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.disabled = !apiId || !apiHash;

    console.log(`[GramJS] initialized (multi-phone, subscription-based — no billing gate)`);
  }

  // ── Auth Flow ────────────────────────────────────────

  async sendCode(locationId, phoneNumber, { confirmTransfer = false } = {}) {
    if (this.disabled) throw new Error('Phone login is not configured');

    // Conflict check: is this phone already connected to a DIFFERENT location?
    // If so, require explicit user confirmation before sending the OTP. We'll
    // disconnect the old phone's client and remove its Phone doc during _completeAuth.
    const existing = await Phone.findOne({
      locationId: { $ne: locationId },
      phoneNumber,
      isActive: true,
    }).select('_id locationId phoneNumber displayName telegramUsername').lean();

    if (existing && !confirmTransfer) {
      const err = new Error('This Telegram number is already connected to another sub-account.');
      err.statusCode = 409;
      err.code = 'PHONE_ALREADY_CONNECTED';
      err.details = {
        requiresTransfer: true,
        fromLocationId: existing.locationId,
        displayName: existing.displayName || '',
        telegramUsername: existing.telegramUsername || '',
        phoneNumber,
      };
      throw err;
    }

    // Clean up any existing auth session for this location
    await PhoneAuthSession.deleteOne({ locationId });

    const session = new StringSession('');
    const client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
    });

    await client.connect();

    try {
      const result = await client.invoke(
        new Api.auth.SendCode({
          phoneNumber,
          apiId: this.apiId,
          apiHash: this.apiHash,
          settings: new Api.CodeSettings({}),
        }),
      );

      // Save the temporary session and phone code hash
      const tempSessionString = client.session.save();

      await PhoneAuthSession.create({
        locationId,
        phoneNumber,
        phoneCodeHash: result.phoneCodeHash,
        tempSessionString: this.crypto.encrypt(tempSessionString),
        step: 'code_sent',
        transferFromLocationId: existing ? existing.locationId : null,
      });

      // Destroy to free resources (session string is already saved)
      await client.destroy();

      return { phoneCodeHash: result.phoneCodeHash };
    } catch (error) {
      await client.destroy();

      if (error.message?.includes('PHONE_NUMBER_INVALID')) {
        const err = new Error('Invalid phone number format');
        err.statusCode = 400;
        throw err;
      }
      if (error.message?.includes('FLOOD_WAIT')) {
        const seconds = parseInt(error.message.split('_').pop(), 10) || 60;
        const err = new Error(`Too many attempts. Please wait ${seconds} seconds.`);
        err.statusCode = 429;
        throw err;
      }
      throw error;
    }
  }

  async verifyCode(locationId, phoneCode) {
    const authSession = await PhoneAuthSession.findOne({ locationId });
    if (!authSession) {
      const err = new Error('No pending auth session. Please request a new code.');
      err.statusCode = 400;
      throw err;
    }

    const tempSessionString = this.crypto.decrypt(authSession.tempSessionString);
    const client = new TelegramClient(
      new StringSession(tempSessionString),
      this.apiId,
      this.apiHash,
      { connectionRetries: 5 },
    );

    await client.connect();

    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: authSession.phoneNumber,
          phoneCodeHash: authSession.phoneCodeHash,
          phoneCode,
        }),
      );

      // Success — save final session and complete auth
      return await this._completeAuth(client, locationId, authSession.phoneNumber);
    } catch (error) {
      if (error.message?.includes('SESSION_PASSWORD_NEEDED')) {
        // 2FA required — save updated session and wait for password
        const updatedSession = client.session.save();
        await PhoneAuthSession.updateOne(
          { locationId },
          {
            tempSessionString: this.crypto.encrypt(updatedSession),
            step: 'awaiting_2fa',
          },
        );
        await client.destroy();

        return { require2FA: true };
      }

      await client.destroy();

      if (error.message?.includes('PHONE_CODE_INVALID')) {
        const err = new Error('Invalid verification code');
        err.statusCode = 400;
        throw err;
      }
      if (error.message?.includes('PHONE_CODE_EXPIRED')) {
        await PhoneAuthSession.deleteOne({ locationId });
        const err = new Error('Verification code expired. Please request a new one.');
        err.statusCode = 400;
        throw err;
      }
      throw error;
    }
  }

  async submit2FA(locationId, password) {
    const authSession = await PhoneAuthSession.findOne({
      locationId,
      step: 'awaiting_2fa',
    });
    if (!authSession) {
      const err = new Error('No pending 2FA session. Please start over.');
      err.statusCode = 400;
      throw err;
    }

    const tempSessionString = this.crypto.decrypt(authSession.tempSessionString);
    const client = new TelegramClient(
      new StringSession(tempSessionString),
      this.apiId,
      this.apiHash,
      { connectionRetries: 5 },
    );

    await client.connect();

    try {
      const passwordResult = await client.invoke(new Api.account.GetPassword());
      const passwordCheck = await computeCheck(passwordResult, password);
      await client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));

      return await this._completeAuth(client, locationId, authSession.phoneNumber);
    } catch (error) {
      await client.destroy();

      if (error.message?.includes('PASSWORD_HASH_INVALID')) {
        const err = new Error('Incorrect password');
        err.statusCode = 401;
        throw err;
      }
      throw error;
    }
  }

  async _completeAuth(client, locationId, phoneNumber) {
    // Read transfer intent before we delete the auth session below.
    const authSession = await PhoneAuthSession.findOne({ locationId }).select('transferFromLocationId').lean();
    const transferFromLocationId = authSession?.transferFromLocationId || null;

    const me = await client.getMe();
    const finalSession = client.session.save();
    const encryptedSession = this.crypto.encrypt(finalSession);

    // Destroy the auth client BEFORE ConnectionManager creates a new one
    // (two clients sharing the same auth key causes AUTH_KEY_DUPLICATED)
    await client.destroy();

    // Transfer: disconnect the previous location's Phone (same number) and remove its
    // Phone doc so the same Telegram account isn't running on two locations at once.
    if (transferFromLocationId && transferFromLocationId !== locationId) {
      try {
        const oldPhone = await Phone.findOne({ locationId: transferFromLocationId, phoneNumber });
        if (oldPhone) {
          try {
            await this.connectionManager.disconnect(String(oldPhone._id));
          } catch (err) {
            console.error(`[Phone] Failed to disconnect old connection ${oldPhone._id} during transfer: ${err.message}`);
          }
          await Phone.deleteOne({ _id: oldPhone._id });
        }
        console.log(`[Phone] Transferred number ${phoneNumber} from location ${transferFromLocationId} → ${locationId}`);
      } catch (err) {
        console.error(`[Phone] Transfer cleanup failed for ${phoneNumber}: ${err.message}`);
      }
    }

    // Upsert the Phone doc for this (location, phoneNumber). The _id is the connectionId.
    const displayName = [me.firstName, me.lastName].filter(Boolean).join(' ');
    const phoneDoc = await Phone.findOneAndUpdate(
      { locationId, phoneNumber },
      {
        locationId,
        phoneNumber,
        sessionString: encryptedSession,
        telegramUserId: String(me.id),
        telegramUsername: me.username || '',
        displayName,
        isActive: true,
        lastActivityAt: new Date(),
      },
      { upsert: true, returnDocument: 'after', new: true },
    );
    const connectionId = String(phoneDoc._id);

    // Clean up auth session
    await PhoneAuthSession.deleteOne({ locationId });

    // Connect the client in the ConnectionManager pool (keyed by connectionId)
    await this.connectionManager.connect(connectionId, encryptedSession);

    // Register inbound message handler (carry both locationId and connectionId)
    this.connectionManager.onNewMessage(connectionId, (event) =>
      this.handleInboundUpdate(locationId, connectionId, event),
    );
    // Register handler for manual agent replies sent from the native Telegram app
    this.connectionManager.onOutgoingMessage(connectionId, (event) =>
      this.handleOutgoingUpdate(locationId, connectionId, event),
    );

    console.log(`Phone connected for location ${locationId} (connection ${connectionId}): @${me.username || me.id}`);

    // Ensure Telegram custom fields exist so contact data persists in GHL (best-effort).
    if (this.ghlService) {
      this.ghlService.ensureTelegramCustomFields(locationId).catch(() => {});
    }

    return {
      connected: true,
      connectionId,
      user: {
        telegramUserId: String(me.id),
        telegramUsername: me.username || '',
        displayName,
        phoneNumber,
      },
    };
  }

  // ── Inbound Message Processing ───────────────────────

  async handleInboundUpdate(locationId, connectionId, event) {
    const message = event.message;
    if (!message) return;

    const chatId = message.chatId || message.peerId?.userId;
    if (!chatId) return;

    const chatIdNum = typeof chatId === 'bigint' ? Number(chatId) : chatId;

    // Step 1: Get sender info early (needed for write-ahead log)
    const sender = await message.getSender();
    const senderInfo = {
      id: sender?.id != null ? Number(sender.id) : undefined,
      first_name: sender?.firstName || 'Unknown',
      last_name: sender?.lastName || '',
      username: sender?.username || '',
    };

    // Step 2: Write-ahead log (includes sender info + connectionId for recovery)
    const pendingUpdate = await PendingUpdate.create({
      locationId,
      rawUpdate: JSON.stringify(
        { chatId: chatIdNum, text: message.text, messageId: message.id, sender: senderInfo, connectionId },
        (key, value) => (typeof value === 'bigint' ? value.toString() : value),
      ),
      status: 'pending',
    });

    try {
      await PendingUpdate.updateOne(
        { _id: pendingUpdate._id },
        { status: 'processing', lastAttemptAt: new Date(), $inc: { attempts: 1 } },
      );

      // Dedup: key on chatId too — Telegram message ids are unique per-chat, not
      // globally, so without chatId, message #5 in one chat wrongly collides with
      // message #5 in another and real messages get dropped.
      const alreadyProcessed = await MessageLog.findOne({
        locationId,
        telegramChatId: chatIdNum,
        telegramMessageId: message.id,
        direction: MessageDirection.INBOUND,
      });
      if (alreadyProcessed) {
        console.log(`Duplicate phone inbound message ${message.id} in chat ${chatIdNum} for location ${locationId}, skipping`);
        await PendingUpdate.updateOne(
          { _id: pendingUpdate._id },
          { status: 'completed', processedAt: new Date() },
        );
        return;
      }

      // Step 3: Normalize to Bot API shape for contactMappingService
      const telegramUser = senderInfo;

      // Step 4: Get installation for conversation provider ID
      const installation = await Installation.findOne({ locationId });
      if (!installation) {
        throw new Error(`No installation for location: ${locationId}`);
      }

      // v2: NO billing gate. Inbound ALWAYS syncs so we never lose messages.

      // Step 5: Get or create GHL contact. source='phone', connectionId = this phone's
      // _id — the mapping service stamps connectionId + lastConnectionId for outbound routing.
      const { ghlContactId, isNew: isNewContact } = await this.contactMapping.getOrCreateContact(
        locationId,
        telegramUser,
        chatIdNum,
        'phone',
        connectionId,
      );

      // Step 6: Build message content
      let messageText = message.text || message.message || '';

      // Special content (location/contact/poll/venue) has no text and isn't a downloadable
      // file — without this it syncs as a blank thread entry. MTProto shapes differ from the
      // Bot API, so describe them here.
      if (!messageText) {
        const special = this._describeSpecialMedia(message.media);
        if (special) messageText = special;
      }

      // Lead capture: if the contact shared THEIR OWN phone (MTProto sets contact.userId
      // === sender id): link this chat to an existing GHL contact with that number if one
      // exists (merge, no duplicate), otherwise save the number onto this contact.
      const sharedContact = message.media?.className === 'MessageMediaContact' ? message.media : null;
      let sharedPhoneContactId = ghlContactId;
      if (sharedContact?.phoneNumber && String(sharedContact.userId) === String(telegramUser?.id)) {
        const phone = String(sharedContact.phoneNumber).startsWith('+')
          ? sharedContact.phoneNumber
          : `+${sharedContact.phoneNumber}`;
        try {
          sharedPhoneContactId = await this.contactMapping.linkSharedPhoneToExistingContact(
            locationId, chatIdNum, ghlContactId, phone,
          );
          if (sharedPhoneContactId === ghlContactId) {
            await this.ghlService.updateContact(locationId, ghlContactId, { phone });
            console.log(`[Lead] Saved shared phone ${phone} to contact ${ghlContactId} (${locationId})`);
          }
        } catch (err) {
          console.warn(`[Lead] Could not process shared phone for ${ghlContactId} (continuing): ${err.message}`);
        }
      }

      // Lead capture from typed text: phone/email in the message body → fill onto the
      // contact (only empty fields, never overwrite). Cheap pre-check first.
      const rawText = message.text || message.message || '';
      if (rawText && (/@/.test(rawText) || /\d{6,}/.test(rawText.replace(/[^\d]/g, '')))) {
        const info = extractContactInfo(rawText, { defaultCountryCode: process.env.DEFAULT_PHONE_COUNTRY_CODE });
        if (info.phone || info.email) {
          sharedPhoneContactId = await this.contactMapping.matchAndLinkByContactInfo(
            locationId, chatIdNum, sharedPhoneContactId, info,
          );
        }
      }

      // Step 7: Handle media attachments — uploaded to GHL so links don't expire
      const attachments = [];
      const mediaInfo = this._describeMedia(message.media);
      if (mediaInfo?.sticker) {
        // Stickers are .webp/.tgs, which GHL can't show — send the emoji instead.
        if (!messageText) messageText = `${mediaInfo.emoji || ''} (sticker)`.trim();
      } else if (mediaInfo) {
        try {
          const buffer = await this.connectionManager.downloadMedia(connectionId, message.media);
          if (buffer) {
            attachments.push(
              await persistAttachment(this.ghlService, {
                locationId,
                contactId: ghlContactId,
                buffer,
                filename: mediaInfo.filename,
                mimeType: mediaInfo.mimeType,
              }),
            );
          }
        } catch (err) {
          console.warn(`Failed to download media for location ${locationId}:`, err.message);
        }
        if (attachments.length === 0) {
          const note = `[${mediaInfo.label} — could not be loaded]`;
          messageText = messageText ? `${messageText}\n${note}` : note;
        }
      }

      // Step 8: Forward to GHL. If the GHL contact was deleted, recreate it once
      // (drop stale mapping → new contact) and retry, instead of looping forever. Use the
      // phone-linked contact when a shared number merged this chat into an existing record.
      let activeContactId = sharedPhoneContactId;
      let result;
      try {
        result = await this.ghlService.addInboundMessage(locationId, {
          conversationProviderId: installation.conversationProviderId || process.env.GHL_CONVERSATION_PROVIDER_ID,
          contactId: activeContactId,
          message: messageText || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
          altId: String(chatIdNum),
        });
      } catch (err) {
        if (!err.contactDeleted) throw err;
        const recreated = await this.contactMapping.recreateContact(
          locationId, telegramUser, chatIdNum, 'phone', connectionId,
        );
        activeContactId = recreated.ghlContactId;
        result = await this.ghlService.addInboundMessage(locationId, {
          conversationProviderId: installation.conversationProviderId || process.env.GHL_CONVERSATION_PROVIDER_ID,
          contactId: activeContactId,
          message: messageText || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
          altId: String(chatIdNum),
        });
      }

      // Step 9: Log the message
      await MessageLog.create({
        locationId,
        direction: MessageDirection.INBOUND,
        telegramChatId: chatIdNum,
        ghlMessageId: result.messageId,
        telegramMessageId: message.id,
        status: MessageStatus.DELIVERED,
      });

      // Step 10: Update activity timestamp on the Phone doc.
      await Phone.updateOne({ _id: connectionId }, { $set: { lastActivityAt: new Date() } });

      // Step 11: Mark write-ahead as completed
      await PendingUpdate.updateOne(
        { _id: pendingUpdate._id },
        { status: 'completed', processedAt: new Date() },
      );

      console.log(
        `Phone inbound synced: chat ${chatIdNum} → GHL message ${result.messageId} (location ${locationId}, connection ${connectionId})`,
      );

      // Step 12: Fire workflow triggers (fire-and-forget)
      if (this.workflows) {
        // Detect media type from the GramJS message.media class — keeps parity with the bot path.
        const detectMediaType = (media) => {
          if (!media || media.className === 'MessageMediaEmpty' || media.className === 'MessageMediaWebPage') return null;
          if (media.className === 'MessageMediaPhoto') return 'photo';
          if (media.className === 'MessageMediaDocument') {
            const mime = media.document?.mimeType || '';
            if (mime.startsWith('video/')) return 'video';
            if (mime.startsWith('audio/')) return 'audio';
            if (mime.startsWith('image/')) return 'photo';
            return 'document';
          }
          return 'document';
        };
        const mediaType = detectMediaType(message.media);

        const triggerPayload = {
          // Use activeContactId — if the contact was deleted in GHL and recreated
          // above, this is the live one; the old ghlContactId would be a dead contact.
          contactId: activeContactId,
          telegramChatId: chatIdNum,
          // Sender's actual Telegram user ID — correct for group messages (where
          // chatId is the group's id), and equals chatId for 1:1 DMs.
          telegramUserId: telegramUser.id,
          telegramUsername: telegramUser.username || '',
          telegramFirstName: telegramUser.first_name,
          messageText: messageText,
          messageType: mediaType || 'text',
          telegramMessageId: message.id,
          timestamp: new Date().toISOString(),
        };

        console.log(`[Workflows] Firing telegram_message_received for location ${locationId} (phone)`);
        this.workflows
          .fireTrigger(TRIGGERS.MESSAGE_RECEIVED, locationId, triggerPayload)
          .catch((err) => console.error(`[Workflows] Failed to fire message trigger: ${err.message}`));

        // Media received (photo, video, audio, document)
        if (mediaType) {
          const mediaPayload = {
            ...triggerPayload,
            mediaType,
            mediaUrl: attachments.length > 0 ? attachments[0] : '',
          };
          console.log(`[Workflows] Firing telegram_media_received for location ${locationId} (phone, ${mediaType})`);
          this.workflows
            .fireTrigger(TRIGGERS.MEDIA_RECEIVED, locationId, mediaPayload)
            .catch((err) => console.error(`[Workflows] Failed to fire media trigger: ${err.message}`));
        }

        if (isNewContact) {
          console.log(`[Workflows] Firing new_telegram_contact for location ${locationId} (phone)`);
          this.workflows
            .fireTrigger(TRIGGERS.NEW_CONTACT, locationId, triggerPayload)
            .catch((err) => console.error(`[Workflows] Failed to fire new contact trigger: ${err.message}`));
        }
      }
    } catch (error) {
      const code = error.code || error.codeName;
      const status = error.response?.status;
      const ghlMsg = error.response?.data?.message || error.response?.data?.error;
      console.error(
        `Failed to process phone inbound for location ${locationId}\n` +
        `  Step: ${error._step || 'unknown'}\n` +
        `  Type: ${error.name || 'Error'}${code ? ` (${code})` : ''}${status ? ` [HTTP ${status}]` : ''}\n` +
        `  Message: ${ghlMsg || error.message}\n` +
        `  Stack: ${error.stack?.split('\n').slice(0, 3).join(' | ')}`
      );

      // A dead OAuth token (agency revoked / reauthorized) will never succeed on
      // retry and just spams logs — fail fast. Covers both the raw invalid_grant and
      // the follow-on "No active company token" once we've deactivated it.
      const ghlErr = error.response?.data?.error || '';
      const isTerminalAuth =
        ghlErr === 'invalid_grant' ||
        /invalid_grant|No active company token/i.test(error.message || '');

      const updated = await PendingUpdate.findById(pendingUpdate._id);
      if (isTerminalAuth || (updated && updated.attempts >= updated.maxAttempts)) {
        await PendingUpdate.updateOne(
          { _id: pendingUpdate._id },
          { status: 'failed', errorMessage: error.message },
        );
        if (isTerminalAuth) {
          console.error(`[Phone] Terminal auth failure for ${locationId} (invalid_grant) — marking update failed, not retrying`);
        }
      } else {
        await PendingUpdate.updateOne(
          { _id: pendingUpdate._id },
          { status: 'pending', errorMessage: error.message },
        );
      }
    }
  }

  // ── Manual Agent Reply Processing (outgoing from native Telegram app) ──

  /**
   * Handle an OUTGOING message on a connected phone account. This fires for BOTH:
   *   (a) messages WE sent programmatically (workflow actions / CRM outbound), and
   *   (b) messages a human agent typed manually in the native Telegram app.
   * We only care about (b). Our own sends are already recorded in MessageLog as OUTBOUND
   * with their telegramMessageId, so if this message id is already logged, it's ours —
   * skip. Otherwise it's a manual agent reply → sync it to the GHL conversation and fire
   * the `telegram_agent_reply` trigger (so a workflow can, e.g., pause the AI bot).
   */
  async handleOutgoingUpdate(locationId, connectionId, event) {
    try {
      const message = event.message;
      if (!message) return;

      const chatId = message.chatId || message.peerId?.userId;
      if (!chatId) return;
      const chatIdNum = typeof chatId === 'bigint' ? Number(chatId) : chatId;

      // Skip if this outgoing message id is already logged — either it's one WE sent
      // programmatically, or a re-delivery of a manual reply we already handled.
      const already = await MessageLog.findOne({
        locationId,
        telegramMessageId: message.id,
        direction: MessageDirection.OUTBOUND,
      });
      if (already) return;

      const messageText = message.text || message.message || '';
      const installation = await Installation.findOne({ locationId });
      if (!installation) return;

      // Only sync for contacts we already know (they must have an existing mapping —
      // a manual reply is always to an existing conversation).
      const ghlContactId = await this.contactMapping.getGhlContactId?.(locationId, chatIdNum);
      const mappingContactId = ghlContactId || null;

      // Reflect the agent's reply in the GHL conversation (best-effort).
      if (mappingContactId && messageText) {
        try {
          await this.ghlService.addOutboundMessage(locationId, {
            conversationProviderId: installation.conversationProviderId || process.env.GHL_CONVERSATION_PROVIDER_ID,
            contactId: mappingContactId,
            message: messageText,
            altId: String(chatIdNum),
          });
        } catch (err) {
          console.warn(`[AgentReply] Failed to sync manual reply to GHL for ${locationId}: ${err.message}`);
        }
      }

      // Log it so we don't double-process, and for reporting.
      await MessageLog.create({
        locationId,
        direction: MessageDirection.OUTBOUND,
        telegramChatId: chatIdNum,
        telegramMessageId: message.id,
        status: MessageStatus.DELIVERED,
        source: 'manual',
      });

      console.log(`[AgentReply] Manual agent reply synced for ${locationId} → chat ${chatIdNum} (connection ${connectionId})`);

      // v2: no billing — agent replies are never charged.

      // Fire the trigger so workflows can react (e.g. pause the Conversation AI bot).
      if (this.workflows && mappingContactId) {
        this.workflows
          .fireTrigger(TRIGGERS.AGENT_REPLY, locationId, {
            contactId: mappingContactId,
            telegramChatId: chatIdNum,
            telegramUserId: chatIdNum, // agent replied to a 1:1 contact — chatId is their user ID
            messageText,
            telegramMessageId: message.id,
            timestamp: new Date().toISOString(),
          })
          .catch((err) => console.error(`[Workflows] agent_reply trigger: ${err.message}`));
      }
    } catch (error) {
      console.error(`[AgentReply] handleOutgoingUpdate error for ${locationId}: ${error.message}`);
    }
  }

  // ── Media Description ────────────────────────────────

  /**
   * Describe a GramJS message.media for upload: file name, mime type and a label
   * for the fallback note. Returns null for media we don't download (link
   * previews, locations, contacts, polls) and { sticker, emoji } for stickers.
   */
  _describeMedia(media) {
    if (!media) return null;

    if (media.className === 'MessageMediaPhoto') {
      return { filename: 'telegram-photo.jpg', mimeType: 'image/jpeg', label: '🖼️ Photo' };
    }

    if (media.className !== 'MessageMediaDocument' || !media.document) return null;

    const attrs = media.document.attributes || [];
    const sticker = attrs.find((a) => a.className === 'DocumentAttributeSticker');
    if (sticker) return { sticker: true, emoji: sticker.alt };

    const mimeType = media.document.mimeType || 'application/octet-stream';
    const category = mediaCategory(mimeType);
    const isVoice = attrs.some((a) => a.className === 'DocumentAttributeAudio' && a.voice);
    const isRound = attrs.some((a) => a.className === 'DocumentAttributeVideo' && a.roundMessage);
    const isGif = attrs.some((a) => a.className === 'DocumentAttributeAnimated');
    const original = attrs.find((a) => a.className === 'DocumentAttributeFilename')?.fileName;

    let label = `📎 File${original ? `: ${original}` : ''}`;
    if (isVoice) label = '🎤 Voice message';
    else if (isRound) label = '🎬 Video message';
    else if (isGif) label = '🎞️ GIF';
    else if (category === 'video') label = '🎬 Video';
    else if (category === 'audio') label = '🎵 Audio';
    else if (category === 'photo') label = '🖼️ Photo';

    // Voice notes have no file name; give everything a real extension so GHL
    // recognises the type (e.g. .ogg, which its upload accepts).
    const filename = original || `telegram-${category}${extFromMime(mimeType)}`;
    return { filename, mimeType, label };
  }

  /**
   * Render MTProto "special" media (geo location, venue, contact, poll) into readable
   * text for GHL. Returns '' when the media isn't one of these. Shapes are GramJS/
   * MTProto classes, not Bot API field names.
   */
  _describeSpecialMedia(media) {
    if (!media || typeof media !== 'object') return '';
    const cls = media.className;

    if ((cls === 'MessageMediaGeo' || cls === 'MessageMediaGeoLive') && media.geo) {
      return `[Location] https://maps.google.com/?q=${media.geo.lat},${media.geo.long}`;
    }
    if (cls === 'MessageMediaVenue') {
      const parts = [media.title, media.address].filter(Boolean).join(', ');
      const map = media.geo ? ` https://maps.google.com/?q=${media.geo.lat},${media.geo.long}` : '';
      return `[Venue] ${parts}${map}`.trim();
    }
    if (cls === 'MessageMediaContact') {
      const name = [media.firstName, media.lastName].filter(Boolean).join(' ');
      return `[Contact] ${[name, media.phoneNumber].filter(Boolean).join(' · ')}`.trim();
    }
    if (cls === 'MessageMediaPoll' && media.poll) {
      const q = media.poll.question?.text || media.poll.question || '';
      const opts = Array.isArray(media.poll.answers)
        ? media.poll.answers.map((a) => a.text?.text || a.text).filter(Boolean)
        : [];
      const optLine = opts.length ? `\n- ${opts.join('\n- ')}` : '';
      return `[Poll] ${q}${optLine}`.trim();
    }
    return '';
  }

  // ── Lifecycle ────────────────────────────────────────

  async initAllClients() {
    if (this.disabled) return;

    // v2 MULTI-PHONE: iterate Phone docs (not Installation.phoneConfig). Eagerly reconnect
    // every active phone so MTProto inbound updates flow immediately on a live connection
    // — lazy-on-first-outbound would leave inbound dead until the user sends something.
    const phones = await Phone.find({
      isActive: true,
      sessionString: { $exists: true, $ne: '' },
    }).select('_id locationId sessionString');

    if (phones.length === 0) {
      console.log('No active phone connections to restore');
      await this.recoverPendingUpdates();
      return;
    }

    console.log(`${phones.length} phone connection(s) found — reconnecting with stagger...`);

    // Stagger between connects to avoid Telegram rate limits / auth-key conflicts on
    // datacenter handshakes. With 100s of sessions, keep this generous. Override via
    // PHONE_RECONNECT_STAGGER_MS without a redeploy.
    const STAGGER_MS = Number(process.env.PHONE_RECONNECT_STAGGER_MS) || 3000;
    for (const phone of phones) {
      const connectionId = String(phone._id);
      const locationId = phone.locationId;

      // Register the inbound handler BEFORE connect() so _registerEventHandler finds it.
      this.connectionManager.onNewMessage(connectionId, (event) =>
        this.handleInboundUpdate(locationId, connectionId, event),
      );
      // Manual agent replies from the native Telegram app.
      this.connectionManager.onOutgoingMessage(connectionId, (event) =>
        this.handleOutgoingUpdate(locationId, connectionId, event),
      );

      // No retry loop. On any hard session failure (duplicated / revoked), the
      // connect() call marks the Phone inactive so the app prompts the owner to
      // reconnect — no endless backoff, no reconnect storm.
      try {
        await this.connectionManager.connect(connectionId, phone.sessionString);
      } catch (err) {
        console.error(`[Startup] Failed to reconnect phone ${connectionId} (${locationId}): ${err.message}`);
      }

      await new Promise((r) => setTimeout(r, STAGGER_MS));
    }

    // Recover any pending updates from before the restart
    await this.recoverPendingUpdates();
  }

  async recoverPendingUpdates() {
    const pending = await PendingUpdate.find({
      status: { $in: ['pending', 'processing'] },
      $expr: { $lt: ['$attempts', '$maxAttempts'] },
    }).sort({ createdAt: 1 });

    if (pending.length === 0) return;

    console.log(`Recovering ${pending.length} pending updates...`);

    for (const update of pending) {
      try {
        const parsed = JSON.parse(update.rawUpdate);
        await PendingUpdate.updateOne(
          { _id: update._id },
          { status: 'processing', lastAttemptAt: new Date(), $inc: { attempts: 1 } },
        );

        const installation = await Installation.findOne({ locationId: update.locationId });
        if (!installation) {
          await PendingUpdate.updateOne(
            { _id: update._id },
            { status: 'failed', errorMessage: 'Installation not found' },
          );
          continue;
        }

        // v2: no billing — recovered inbound always re-syncs.

        // Re-forward to GHL using stored data (sender info + connectionId preserved).
        const senderInfo = parsed.sender || {
          first_name: 'Telegram User',
          last_name: '',
          username: '',
        };
        const { ghlContactId } = await this.contactMapping.getOrCreateContact(
          update.locationId,
          senderInfo,
          parsed.chatId,
          'phone',
          parsed.connectionId || '',
        );

        await this.ghlService.addInboundMessage(update.locationId, {
          conversationProviderId: installation.conversationProviderId || process.env.GHL_CONVERSATION_PROVIDER_ID,
          contactId: ghlContactId,
          message: parsed.text || undefined,
          altId: String(parsed.chatId),
        });

        await PendingUpdate.updateOne(
          { _id: update._id },
          { status: 'completed', processedAt: new Date() },
        );
      } catch (error) {
        console.error(`Failed to recover update ${update._id}:`, error.message);
        const current = await PendingUpdate.findById(update._id);
        if (current && current.attempts >= current.maxAttempts) {
          await PendingUpdate.updateOne(
            { _id: update._id },
            { status: 'failed', errorMessage: error.message },
          );
        }
      }
    }
  }

  async destroyClient(connectionId) {
    await this.connectionManager.disconnect(connectionId);
  }
}

module.exports = GramJsService;
