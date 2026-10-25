const { Router } = require('express');
const axios = require('axios');
const Installation = require('../schemas/installation.schema');
const Bot = require('../schemas/bot.schema');
const Phone = require('../schemas/phone.schema');
const { MessageLog, MessageDirection, MessageStatus } = require('../schemas/message-log.schema');
const ArchivedToken = require('../schemas/archived-token.schema');
const CompanyLocation = require('../schemas/company-location.schema');
const PhoneAuthSession = require('../schemas/phone-auth-session.schema');
const ContactMapping = require('../schemas/contact-mapping.schema');
const { formatError } = require('../utils/format-error');
const { ghlSignatureGuard, GHL_WEBHOOK_VERIFY_MODE } = require('./ghl-signature');
const path = require('path');
const { persistAttachment, mediaCategory, extFromMime } = require('../media/media-store');
const { describeSpecialContent } = require('./special-content');
const { extractContactInfo } = require('../utils/contact-extract');
const { TRIGGERS } = require('../workflows/trigger-keys');

// Bot API refuses getFile for anything larger than 20 MB.
const BOT_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Pick the media out of a Bot API message. Returns null for text-only messages.
 * Order matters: Telegram also fills `document` on GIFs (`animation`), so
 * animation must be checked before document.
 */
function extractBotMedia(message) {
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return {
      fileId: largest.file_id,
      fileSize: largest.file_size,
      mimeType: 'image/jpeg',
      category: 'photo',
      label: '🖼️ Photo',
    };
  }

  const pick = (obj, label, defaultMime) => ({
    fileId: obj.file_id,
    fileSize: obj.file_size,
    filename: obj.file_name,
    mimeType: obj.mime_type || defaultMime,
    label,
  });

  let media = null;
  if (message.animation) media = pick(message.animation, '🎞️ GIF', 'video/mp4');
  else if (message.video) media = pick(message.video, '🎬 Video', 'video/mp4');
  else if (message.video_note) media = pick(message.video_note, '🎬 Video message', 'video/mp4');
  else if (message.voice) media = pick(message.voice, '🎤 Voice message', 'audio/ogg');
  else if (message.audio) media = pick(message.audio, '🎵 Audio', 'audio/mpeg');
  else if (message.document) {
    media = pick(message.document, `📎 File${message.document.file_name ? `: ${message.document.file_name}` : ''}`, 'application/octet-stream');
  } else if (message.sticker) {
    return { sticker: true, emoji: message.sticker.emoji };
  }

  if (media) media.category = mediaCategory(media.mimeType);
  return media;
}

/**
 * v2 WEBHOOKS. The Bot inbound path is per-bot (/telegram/:locationId/:botId) and the
 * secret is validated against THAT Bot's webhookSecret. There is NO billing — inbound
 * always syncs. Outbound resolves the connection via the contact mapping's
 * lastConnectionId. App-lifecycle drives the Subscription (trial / cancel / plan-change /
 * payment status) instead of a wallet.
 */
function createWebhooksRouter(
  connectionService,
  telegramService,
  ghlService,
  contactMappingService,
  connectionManager,
  workflowsService,
  subscriptionService,
) {
  const router = Router();

  console.log(`[Webhook] GHL signature verification: ${GHL_WEBHOOK_VERIFY_MODE.toUpperCase()}`);

  // ═══════════════════════════════════════════════════════════
  // INBOUND: Telegram → GHL (Bot API webhooks, per-bot)
  // ═══════════════════════════════════════════════════════════

  router.post('/telegram/:locationId/:botId', async (req, res) => {
    const { locationId, botId } = req.params;
    const secretToken = req.headers['x-telegram-bot-api-secret-token'];
    const update = req.body;

    // Step 1: Find the Bot doc by its _id and validate the webhook secret against it.
    const bot = await Bot.findOne({ _id: botId, locationId }).catch(() => null);
    if (!bot || !bot.webhookSecret || secretToken !== bot.webhookSecret) {
      console.warn(
        `[Webhook] Rejected Telegram update for ${locationId}/${botId}: ${bot ? 'secret mismatch' : 'bot not found'} — reconnect the bot to re-sync.`,
      );
      return res.status(401).json({ error: 'Invalid Telegram webhook secret' });
    }

    const botToken = (() => {
      try { return connectionService.crypto.decrypt(bot.botToken); } catch { return null; }
    })();

    // Step 2: Route non-message updates (inline-button taps, membership/block changes)
    // before the message path. These are best-effort and always ack 200 to Telegram.
    if (update.callback_query) {
      handleCallbackQuery(locationId, botId, botToken, update.callback_query).catch((err) =>
        console.error(`[Webhook] callback_query handler failed for ${locationId}: ${err.message}`),
      );
      return res.json({ ok: true });
    }
    if (update.my_chat_member || update.chat_member) {
      handleChatMemberUpdate(locationId, update.my_chat_member || update.chat_member, !!update.my_chat_member)
        .catch((err) => console.error(`[Webhook] chat_member handler failed for ${locationId}: ${err.message}`));
      return res.json({ ok: true });
    }

    // Step 2b: Extract the message (handle both new and edited messages)
    const message = update.message || update.edited_message;
    if (!message) {
      console.debug('Received Telegram update without a message, skipping');
      return res.json({ ok: true });
    }

    const chatId = message.chat.id;
    const telegramUser = message.from;
    const isEdited = !!update.edited_message;

    console.log(`Inbound Telegram message from chat ${chatId} for location ${locationId} (bot ${botId})`);

    try {
      // Dedup: skip only if THIS exact message was already processed. Telegram
      // message_id is unique per-chat, NOT globally — so we must key on chatId too.
      const alreadyProcessed = await MessageLog.findOne({
        locationId,
        telegramChatId: chatId,
        telegramMessageId: message.message_id,
        direction: MessageDirection.INBOUND,
      });
      if (alreadyProcessed) {
        console.log(`Duplicate bot inbound message ${message.message_id} in chat ${chatId} for location ${locationId}, skipping`);
        return res.json({ ok: true });
      }

      // Step 3: Get the installation's conversation provider ID
      const installation = await Installation.findOne({ locationId });
      if (!installation) {
        console.error(`No installation found for location: ${locationId}`);
        return res.json({ ok: false });
      }

      // v2: NO billing gate. Inbound ALWAYS syncs so we never lose messages.

      // Step 4: Get or create the GHL contact. source='bot', connectionId = this bot's _id
      // — the mapping service stamps connectionId + lastConnectionId for outbound routing.
      const { ghlContactId, isNew: isNewContact } =
        await contactMappingService.getOrCreateContact(locationId, telegramUser, chatId, 'bot', botId);

      // Step 5: Build the message content
      let messageText = message.text || message.caption || '';
      if (isEdited && messageText) {
        messageText = `[Edited] ${messageText}`;
      }

      // Special content (location, venue, contact, poll, dice) has no text/caption.
      if (!messageText) {
        const special = describeSpecialContent(message);
        if (special) messageText = special;
      }

      // Lead capture: contact shared THEIR OWN phone number.
      let sharedPhoneContactId = ghlContactId;
      if (message.contact?.phone_number && String(message.contact.user_id) === String(telegramUser?.id)) {
        const phone = message.contact.phone_number.startsWith('+')
          ? message.contact.phone_number
          : `+${message.contact.phone_number}`;
        try {
          sharedPhoneContactId = await contactMappingService.linkSharedPhoneToExistingContact(
            locationId, chatId, ghlContactId, phone,
          );
          if (sharedPhoneContactId === ghlContactId) {
            await ghlService.updateContact(locationId, ghlContactId, { phone });
            console.log(`[Lead] Saved shared phone ${phone} to contact ${ghlContactId} (${locationId})`);
          }
        } catch (err) {
          console.warn(`[Lead] Could not process shared phone for ${ghlContactId} (continuing): ${err.message}`);
        }
      }

      // Lead capture from typed text: phone/email in the message body.
      const rawText = message.text || message.caption || '';
      if (rawText && (/@/.test(rawText) || /\d{6,}/.test(rawText.replace(/[^\d]/g, '')))) {
        const info = extractContactInfo(rawText, { defaultCountryCode: process.env.DEFAULT_PHONE_COUNTRY_CODE });
        if (info.phone || info.email) {
          sharedPhoneContactId = await contactMappingService.matchAndLinkByContactInfo(
            locationId, chatId, sharedPhoneContactId, info,
          );
        }
      }

      // Step 6: Handle attachments (photo, video, voice, audio, file, GIF, sticker).
      const attachments = [];
      const media = extractBotMedia(message);

      if (media?.sticker) {
        if (!messageText) messageText = `${media.emoji || ''} (sticker)`.trim();
      } else if (media) {
        let attachmentUrl = null;

        if (botToken && !(media.fileSize > BOT_DOWNLOAD_MAX_BYTES)) {
          try {
            const { buffer, filePath } = await telegramService.downloadFile(botToken, media.fileId);
            attachmentUrl = await persistAttachment(ghlService, {
              locationId,
              contactId: ghlContactId,
              buffer,
              filename:
                media.filename ||
                (extFromMime(media.mimeType)
                  ? `telegram-${media.category}${extFromMime(media.mimeType)}`
                  : path.basename(filePath)),
              mimeType: media.mimeType,
            });
          } catch (err) {
            console.warn(`Failed to fetch ${media.label} for location ${locationId}: ${formatError(err)}`);
          }
        }

        if (attachmentUrl) {
          attachments.push(attachmentUrl);
        } else {
          const reason = media.fileSize > BOT_DOWNLOAD_MAX_BYTES ? 'too large to load' : 'could not be loaded';
          const note = `[${media.label} — ${reason}]`;
          messageText = messageText ? `${messageText}\n${note}` : note;
        }
      }

      // Step 7: Push to GHL Conversations. If the GHL contact was deleted, recreate once.
      let activeContactId = sharedPhoneContactId;
      let result;
      try {
        result = await ghlService.addInboundMessage(locationId, {
          conversationProviderId: installation.conversationProviderId,
          contactId: activeContactId,
          message: messageText || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
          altId: String(chatId),
        });
      } catch (err) {
        if (!err.contactDeleted) throw err;
        const recreated = await contactMappingService.recreateContact(
          locationId, telegramUser, chatId, 'bot', botId,
        );
        activeContactId = recreated.ghlContactId;
        result = await ghlService.addInboundMessage(locationId, {
          conversationProviderId: installation.conversationProviderId,
          contactId: activeContactId,
          message: messageText || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
          altId: String(chatId),
        });
      }

      // Step 8: Log the message
      await MessageLog.create({
        locationId,
        direction: MessageDirection.INBOUND,
        telegramChatId: chatId,
        ghlMessageId: result.messageId,
        telegramMessageId: message.message_id,
        status: MessageStatus.DELIVERED,
      });

      // Bump the bot's activity timestamp (best-effort).
      Bot.updateOne({ _id: botId }, { $set: { lastActivityAt: new Date() } }).catch(() => {});

      console.log(
        `Inbound message synced: Telegram chat ${chatId} → GHL message ${result.messageId}`,
      );

      // Step 9: Fire workflow triggers (fire-and-forget)
      if (workflowsService) {
        const messageType = message.text
          ? 'text'
          : media && !media.sticker
            ? media.category
            : 'other';
        const triggerPayload = {
          contactId: activeContactId,
          telegramChatId: chatId,
          telegramUserId: telegramUser?.id,
          telegramUsername: telegramUser.username || '',
          telegramFirstName: telegramUser.first_name,
          messageText: messageText,
          messageType,
          telegramMessageId: message.message_id,
          timestamp: new Date().toISOString(),
        };

        workflowsService.fireTrigger(TRIGGERS.MESSAGE_RECEIVED, locationId, triggerPayload)
          .catch((err) => console.error(`[Workflows] message trigger: ${err.message}`));

        if (isEdited) {
          workflowsService.fireTrigger(TRIGGERS.MESSAGE_EDITED, locationId, triggerPayload)
            .catch((err) => console.error(`[Workflows] edited trigger: ${err.message}`));
        }

        if (isNewContact) {
          workflowsService.fireTrigger(TRIGGERS.NEW_CONTACT, locationId, triggerPayload)
            .catch((err) => console.error(`[Workflows] new contact trigger: ${err.message}`));
        }

        if (messageText && messageText.startsWith('/')) {
          const command = messageText.split(' ')[0].split('@')[0]; // /start@botname → /start
          workflowsService.fireTrigger(TRIGGERS.BOT_COMMAND, locationId, { ...triggerPayload, command })
            .catch((err) => console.error(`[Workflows] bot command trigger: ${err.message}`));
        }

        if (['photo', 'video', 'audio', 'document'].includes(messageType)) {
          const mediaPayload = {
            ...triggerPayload,
            mediaType: messageType,
            mediaUrl: attachments.length > 0 ? attachments[0] : '',
          };
          workflowsService.fireTrigger(TRIGGERS.MEDIA_RECEIVED, locationId, mediaPayload)
            .catch((err) => console.error(`[Workflows] media trigger: ${err.message}`));
        }

        try {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          const recentMessage = await MessageLog.findOne({
            locationId,
            telegramChatId: chatId,
            direction: MessageDirection.INBOUND,
            createdAt: { $gte: sevenDaysAgo },
            _id: { $ne: result.messageId },
          }).lean();

          if (!recentMessage && !isNewContact) {
            workflowsService.fireTrigger(TRIGGERS.CONTACT_REACTIVATED, locationId, triggerPayload)
              .catch((err) => console.error(`[Workflows] reactivated trigger: ${err.message}`));
          }
        } catch (err) {
          // Don't block on reactivation check failure
        }
      }

      res.json({ ok: true });
    } catch (error) {
      console.error(`Failed to process inbound Telegram message from chat ${chatId}`);
      console.error(
        `Error: ${error.message}` +
          (error?.response?.status ? ` | Status: ${error.response.status}` : '') +
          (error?.response?.data ? ` | Response: ${JSON.stringify(error.response.data)}` : ''),
      );
      if (error?.stack) {
        console.error(`Stack: ${error.stack}`);
      }

      await MessageLog.create({
        locationId,
        direction: MessageDirection.INBOUND,
        telegramChatId: chatId,
        telegramMessageId: message.message_id,
        status: MessageStatus.FAILED,
        errorMessage: error.message || 'Unknown error',
      });

      res.json({ ok: false });
    }
  });

  /**
   * Inline-button tap (callback_query). Fires telegram_button_clicked with the button's
   * callback data, then acknowledges the tap. Uses the bot this update came through.
   */
  async function handleCallbackQuery(locationId, botId, botToken, cq) {
    const from = cq.from || {};
    const chatId = cq.message?.chat?.id ?? from.id;

    // Always answer the callback so the client spinner clears (best-effort).
    try {
      if (botToken) await telegramService.answerCallbackQuery(botToken, cq.id);
    } catch (err) {
      console.warn(`[Webhook] answerCallbackQuery failed for ${locationId}: ${err.message}`);
    }

    const installation = await Installation.findOne({ locationId });
    if (!installation) return;

    // v2: no billing — events always fire.
    const { ghlContactId } = await contactMappingService.getOrCreateContact(
      locationId,
      { id: from.id, first_name: from.first_name, last_name: from.last_name, username: from.username },
      chatId,
      'bot',
      botId,
    );

    if (workflowsService) {
      workflowsService.fireTrigger(TRIGGERS.BUTTON_CLICKED, locationId, {
        contactId: ghlContactId,
        telegramChatId: chatId,
        telegramUserId: from.id,
        telegramUsername: from.username || '',
        telegramFirstName: from.first_name || '',
        callbackData: cq.data || '',
        callbackQueryId: cq.id,
        messageText: cq.message?.text || '',
        telegramMessageId: cq.message?.message_id,
        timestamp: new Date().toISOString(),
      }).catch((err) => console.error(`[Workflows] button-click trigger: ${err.message}`));
    }
    console.log(`[Webhook] button clicked (${cq.data}) by ${from.id} in ${locationId}`);
  }

  /**
   * Membership / block-status change. `isMyStatus` true → the bot's own status changed.
   * false → another member joined/left a group the bot administers.
   */
  async function handleChatMemberUpdate(locationId, upd, isMyStatus) {
    if (!upd) return;
    const chat = upd.chat || {};
    const newStatus = upd.new_chat_member?.status;
    const oldStatus = upd.old_chat_member?.status;
    const subject = upd.new_chat_member?.user || upd.from || {};

    const installation = await Installation.findOne({ locationId });
    if (!installation) return;

    let triggerKey = null;
    if (isMyStatus && chat.type === 'private') {
      if (newStatus === 'kicked' || newStatus === 'left') triggerKey = TRIGGERS.BOT_BLOCKED;
      else if ((oldStatus === 'kicked' || oldStatus === 'left') && newStatus === 'member') triggerKey = TRIGGERS.BOT_UNBLOCKED;
    } else {
      const joined = ['member', 'administrator', 'creator'].includes(newStatus) &&
        ['left', 'kicked'].includes(oldStatus || 'left');
      const left = ['left', 'kicked'].includes(newStatus) &&
        ['member', 'administrator', 'creator'].includes(oldStatus);
      if (joined) triggerKey = TRIGGERS.MEMBER_JOINED;
      else if (left) triggerKey = TRIGGERS.MEMBER_LEFT;
    }
    if (!triggerKey || !workflowsService) return;

    // v2: no billing — events always fire.
    workflowsService.fireTrigger(triggerKey, locationId, {
      telegramChatId: chat.id,
      chatType: chat.type,
      chatTitle: chat.title || '',
      telegramUserId: subject.id,
      telegramUsername: subject.username || '',
      telegramFirstName: subject.first_name || '',
      oldStatus: oldStatus || '',
      newStatus: newStatus || '',
      timestamp: new Date().toISOString(),
    }).catch((err) => console.error(`[Workflows] ${triggerKey} trigger: ${err.message}`));
    console.log(`[Webhook] ${triggerKey} for ${locationId}: user ${subject.id} in chat ${chat.id}`);
  }

  // ═══════════════════════════════════════════════════════════
  // OUTBOUND: GHL → Telegram
  // ═══════════════════════════════════════════════════════════

  /**
   * Send a GHL-hosted attachment to Telegram via the BOT (download bytes, upload multipart).
   */
  async function sendBotAttachment(botToken, chatId, url) {
    const lower = (url || '').toLowerCase();
    const isImage = /\.(jpg|jpeg|png|gif|webp)(\?|$)/.test(lower);
    const isVoice = /\.(ogg|oga|opus)(\?|$)/.test(lower);
    const isAudio = /\.(mp3|m4a|wav|aac|flac)(\?|$)/.test(lower);

    try {
      const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
      const buffer = Buffer.from(resp.data);
      const mimeType = resp.headers['content-type'] || undefined;
      const filename = path.basename((url.split('?')[0])) || 'file';

      let method = 'sendDocument', field = 'document';
      if (isImage) { method = 'sendPhoto'; field = 'photo'; }
      else if (isVoice) { method = 'sendVoice'; field = 'voice'; }
      else if (isAudio) { method = 'sendAudio'; field = 'audio'; }

      return await telegramService.sendFileBuffer(botToken, chatId, {
        method, field, buffer, filename, mimeType,
      });
    } catch (err) {
      console.warn(`[Outbound] buffer upload failed (${err.message}), falling back to URL send for ${url}`);
      if (isImage) return telegramService.sendPhoto(botToken, chatId, url);
      return telegramService.sendDocument(botToken, chatId, url);
    }
  }

  /**
   * Resolve the OUTBOUND transport for a contact. v2: route back out through the connection
   * the contact last reached us on (mapping.lastConnectionId), falling back to the mapping's
   * origin connectionId, then any active connection on the location.
   * Returns { transport, botToken, connectionId } or null if no connection is available.
   */
  async function resolveOutboundTransport(locationId, mapping) {
    const candidate = mapping?.lastConnectionId || mapping?.connectionId || '';

    if (candidate) {
      const phone = await Phone.findOne({ _id: candidate, locationId, isActive: true }).lean().catch(() => null);
      if (phone) return { transport: 'phone', botToken: null, connectionId: String(phone._id) };
      const botToken = await connectionService.getBotTokenById(locationId, candidate);
      if (botToken) return { transport: 'bot', botToken, connectionId: candidate };
    }

    // Fallback by the mapping's source, then anything active.
    if (mapping?.source === 'phone') {
      const phone = await Phone.findOne({ locationId, isActive: true }).sort({ lastActivityAt: -1 }).lean();
      if (phone) return { transport: 'phone', botToken: null, connectionId: String(phone._id) };
    }
    const anyBot = await connectionService.getAnyActiveBot(locationId);
    if (anyBot) return { transport: 'bot', botToken: anyBot.botToken, connectionId: anyBot.id };
    const anyPhone = await Phone.findOne({ locationId, isActive: true }).sort({ lastActivityAt: -1 }).lean();
    if (anyPhone) return { transport: 'phone', botToken: null, connectionId: String(anyPhone._id) };

    return null;
  }

  router.post('/ghl-outbound', ghlSignatureGuard, async (req, res) => {
    const { locationId, contactId, messageId, message, attachments, replyToAltId } = req.body;

    console.log(`Outbound GHL message ${messageId} for location ${locationId}`);

    let telegramChatId = null;

    try {
      // Subscription gate — an unentitled location can't send.
      try {
        await subscriptionService.ensureEntitled(locationId);
      } catch (gateErr) {
        console.warn(`[Subscription] Outbound not sent for ${locationId} — not entitled`);
        await ghlService.updateMessageStatus(locationId, messageId, 'failed', {
          code: 'subscription_required',
          type: 'saas',
          message: 'An active subscription is required to send messages.',
        });
        return res.json({ ok: true, skipped: 'not_entitled' });
      }

      // Step 1: Resolve the Telegram chat ID
      if (replyToAltId) {
        telegramChatId = Number(replyToAltId);
      } else {
        telegramChatId = await contactMappingService.getTelegramChatId(locationId, contactId);
      }

      if (!telegramChatId) {
        console.error(`No Telegram chat ID found for contact ${contactId} in location ${locationId}`);
        await ghlService.updateMessageStatus(locationId, messageId, 'failed', 'No Telegram chat mapped');
        return res.json({ ok: false });
      }

      // Step 2: Resolve the connection to send through (lastConnectionId → fallback).
      const mapping = await ContactMapping.findOne({ locationId, ghlContactId: contactId });
      const resolved = await resolveOutboundTransport(locationId, mapping);

      if (!resolved) {
        console.error(`No Telegram connection available for location: ${locationId}`);
        await ghlService.updateMessageStatus(locationId, messageId, 'failed', 'No Telegram bot or phone connected');
        return res.json({ ok: false });
      }

      let telegramMessageId;

      if (resolved.transport === 'phone') {
        if (message) {
          telegramMessageId = await connectionManager.sendMessage(resolved.connectionId, telegramChatId, message);
        }
        if (attachments && attachments.length > 0) {
          for (const attachmentUrl of attachments) {
            const isImage = /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(attachmentUrl);
            if (isImage) {
              telegramMessageId = await connectionManager.sendPhoto(resolved.connectionId, telegramChatId, attachmentUrl);
            } else {
              telegramMessageId = await connectionManager.sendDocument(resolved.connectionId, telegramChatId, attachmentUrl);
            }
          }
        }
        // Bump the phone's activity timestamp (best-effort).
        try {
          await Phone.updateOne({ _id: resolved.connectionId }, { $set: { lastActivityAt: new Date() } });
        } catch (tsErr) {
          console.error(`[Outbound] activity timestamp update failed for ${locationId}: ${tsErr.message}`);
        }
      } else {
        const botToken = resolved.botToken;
        if (!botToken) {
          console.error(`No active bot for location: ${locationId}`);
          await ghlService.updateMessageStatus(locationId, messageId, 'failed', 'No Telegram bot configured');
          return res.json({ ok: false });
        }

        if (message) {
          telegramMessageId = await telegramService.sendMessage(botToken, telegramChatId, message);
        }
        if (attachments && attachments.length > 0) {
          for (const attachmentUrl of attachments) {
            telegramMessageId = await sendBotAttachment(botToken, telegramChatId, attachmentUrl);
          }
        }
        // Bump the bot's activity timestamp (best-effort).
        Bot.updateOne({ _id: resolved.connectionId }, { $set: { lastActivityAt: new Date() } }).catch(() => {});
      }

      // ── The Telegram send above succeeded. Post-delivery bookkeeping is best-effort. ──

      await ghlService.updateMessageStatus(locationId, messageId, 'delivered');

      try {
        await MessageLog.create({
          locationId,
          direction: MessageDirection.OUTBOUND,
          telegramChatId,
          ghlMessageId: messageId,
          telegramMessageId: telegramMessageId || undefined,
          status: MessageStatus.DELIVERED,
        });
      } catch (logErr) {
        console.error(`[Outbound] MessageLog failed for ${messageId} (delivered anyway): ${logErr.message}`);
      }

      console.log(`Outbound message synced: GHL message ${messageId} → Telegram chat ${telegramChatId}`);
      return res.json({ ok: true });
    } catch (error) {
      console.error(`Failed to forward outbound message ${messageId} to Telegram`);
      console.error(
        `Error: ${error.message}` +
          (error?.response?.status ? ` | Status: ${error.response.status}` : '') +
          (error?.response?.data ? ` | Response: ${JSON.stringify(error.response.data)}` : ''),
      );

      const emsg = error.message || '';
      const isPhoneDown =
        /No active phone connection|AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/i.test(emsg);
      const failReason = isPhoneDown
        ? 'Telegram phone session expired — reconnect your phone in the app to send messages.'
        : (emsg || 'Telegram send failed');

      await ghlService.updateMessageStatus(locationId, messageId, 'failed', failReason);

      await MessageLog.create({
        locationId,
        direction: MessageDirection.OUTBOUND,
        telegramChatId: telegramChatId || (replyToAltId ? Number(replyToAltId) : 0),
        ghlMessageId: messageId,
        status: MessageStatus.FAILED,
        errorMessage: error.message || 'Unknown error',
      });

      if (workflowsService) {
        const failedChatId = telegramChatId != null ? telegramChatId : undefined;
        workflowsService.fireTrigger(TRIGGERS.MESSAGE_FAILED, locationId, {
          contactId,
          locationId,
          messageId,
          telegramChatId: failedChatId,
          telegramUserId: failedChatId,
          errorMessage: error.message || 'Unknown error',
          messageText: message || '',
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }

      res.json({ ok: false });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // APP LIFECYCLE: Install / Uninstall / Plan change / Payment status
  // ═══════════════════════════════════════════════════════════

  router.post('/ghl-app-lifecycle', ghlSignatureGuard, async (req, res) => {
    const { type } = req.body;

    switch (type) {
      case 'INSTALL':
      case 'UPDATE':
        return await handleAppInstall(req.body, subscriptionService, res);
      case 'UNINSTALL':
        return await handleAppUninstall(req.body, connectionService, telegramService, connectionManager, subscriptionService, res);
      // Plan upgrade/downgrade from the Marketplace. Reconcile bot/phone overflow.
      case 'PLAN_CHANGE':
        return await handlePlanChange(req.body, connectionService, connectionManager, subscriptionService, res);
      // Payment status for the subscription (FAILED → past_due, COMPLETE → active).
      case 'APP_PAYMENT_STATUS':
        return await handlePaymentStatus(req.body, subscriptionService, res);
      default:
        console.warn(`Unknown app lifecycle event type: ${type}`);
        return res.json({ ok: true });
    }
  });

  return router;
}

async function handleAppInstall(payload, subscriptionService, res) {
  const { locationId, companyId, appId, planId } = payload;
  console.log(`App installed for location: ${locationId}, company: ${companyId}`);

  if (locationId && companyId) {
    await CompanyLocation.findOneAndUpdate(
      { companyId },
      { $addToSet: { locationIds: locationId } },
      { upsert: true },
    );

    await Installation.findOneAndUpdate(
      { locationId },
      {
        companyId,
        status: 'active',
        ...(appId ? { appId } : {}),
        $setOnInsert: {
          installedAt: new Date(),
          conversationProviderId: process.env.GHL_CONVERSATION_PROVIDER_ID || '',
        },
        uninstalledAt: null,
      },
      { upsert: true },
    );
    console.log(`Installation recorded for location ${locationId}`);

    // Grant the 3-day trial once (status omitted → activate() grants trial via TrialLedger).
    try {
      await subscriptionService.activate({ locationId, companyId, appId, planId, raw: payload });
    } catch (err) {
      console.error(`[Subscription] activate on install failed for ${locationId}: ${err.message}`);
    }
  }

  res.json({ ok: true });
}

async function handleAppUninstall(payload, connectionService, telegramService, connectionManager, subscriptionService, res) {
  const locationId = payload.locationId;
  console.log(`App uninstalled for location: ${locationId}`);

  try {
    const installation = await Installation.findOne({ locationId });

    if (installation) {
      // Archive tokens — only when still present (duplicate UNINSTALL webhooks are common).
      if (installation.accessToken && installation.refreshToken) {
        try {
          await ArchivedToken.create({
            companyId: installation.companyId,
            locationId,
            accessToken: installation.accessToken,
            refreshToken: installation.refreshToken,
            originalCreatedAt: installation.createdAt,
            originalExpiresAt: installation.tokenExpiresAt,
            deletedAt: new Date(),
            deletionReason: 'app_uninstall',
            uninstallWebhookData: payload,
            autoDeleteAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          });
        } catch (archiveErr) {
          console.warn(`Token archive failed for ${locationId} (continuing cleanup):`, archiveErr.message);
        }
      }

      // Soft-delete installation
      await Installation.updateOne(
        { locationId },
        { status: 'uninstalled', uninstalledAt: new Date(), accessToken: '', refreshToken: '' },
      );
    }

    // Disconnect + deactivate every phone for this location.
    const phones = await Phone.find({ locationId });
    for (const phone of phones) {
      try {
        await connectionManager.disconnect(String(phone._id));
      } catch (err) {
        console.warn(`Failed to disconnect phone ${phone._id} for ${locationId}:`, err.message);
      }
    }
    await Phone.updateMany({ locationId }, { $set: { isActive: false } });

    // Delete every bot's Telegram webhook, then deactivate the bots.
    const bots = await Bot.find({ locationId });
    for (const bot of bots) {
      try {
        const botToken = connectionService.crypto.decrypt(bot.botToken);
        await telegramService.deleteWebhook(botToken);
      } catch (err) {
        console.warn(`Failed to delete webhook for bot ${bot._id} (${locationId}):`, err.message);
      }
    }
    await Bot.updateMany({ locationId }, { $set: { isActive: false } });

    // Clean up any pending phone auth sessions
    await PhoneAuthSession.deleteOne({ locationId });

    // Cancel the subscription.
    try {
      await subscriptionService.setStatus(locationId, 'canceled');
    } catch (err) {
      console.error(`[Subscription] setStatus canceled failed for ${locationId}: ${err.message}`);
    }

    console.log(`Soft-delete cleanup complete for location: ${locationId}`);
  } catch (error) {
    console.error(`Uninstall cleanup failed for ${locationId} | ${formatError(error)}`);
  }

  res.json({ ok: true });
}

async function handlePlanChange(payload, connectionService, connectionManager, subscriptionService, res) {
  const { locationId, companyId, appId } = payload;
  const newPlanId = payload.planId || payload.newPlanId;
  console.log(`Plan change for location ${locationId} → plan ${newPlanId}`);

  try {
    // Activate the new plan (status active) — updates botLimit/phoneLimit on the Subscription.
    const sub = await subscriptionService.activate({
      locationId, companyId, appId, planId: newPlanId, status: 'active', raw: payload,
    });

    const botLimit = sub?.botLimit ?? 0;
    const phoneLimit = sub?.phoneLimit ?? 0;

    // Reconcile overflow: deactivate active bots/phones beyond the new limits. Keep the
    // most recently active ones; deactivate (and for phones, disconnect) the rest.
    const activeBots = await Bot.find({ locationId, isActive: true }).sort({ lastActivityAt: -1, createdAt: -1 });
    if (activeBots.length > botLimit) {
      const overflow = activeBots.slice(botLimit);
      for (const bot of overflow) {
        await Bot.updateOne({ _id: bot._id }, { $set: { isActive: false } });
        console.warn(`[PlanChange] Deactivated bot ${bot._id} for ${locationId} (over new limit ${botLimit})`);
      }
    }

    const activePhones = await Phone.find({ locationId, isActive: true }).sort({ lastActivityAt: -1, createdAt: -1 });
    if (activePhones.length > phoneLimit) {
      const overflow = activePhones.slice(phoneLimit);
      for (const phone of overflow) {
        try {
          await connectionManager.disconnect(String(phone._id));
        } catch (err) {
          console.warn(`[PlanChange] Failed to disconnect overflow phone ${phone._id}: ${err.message}`);
        }
        await Phone.updateOne({ _id: phone._id }, { $set: { isActive: false } });
        console.warn(`[PlanChange] Deactivated phone ${phone._id} for ${locationId} (over new limit ${phoneLimit})`);
      }
    }
  } catch (error) {
    console.error(`Plan change failed for ${locationId} | ${formatError(error)}`);
  }

  res.json({ ok: true });
}

async function handlePaymentStatus(payload, subscriptionService, res) {
  const { locationId } = payload;
  const status = (payload.paymentStatus || payload.status || '').toUpperCase();
  console.log(`Payment status for location ${locationId}: ${status}`);

  try {
    if (status === 'FAILED') {
      await subscriptionService.setStatus(locationId, 'past_due');
    } else if (status === 'COMPLETE' || status === 'COMPLETED' || status === 'SUCCESS') {
      await subscriptionService.setStatus(locationId, 'active');
    } else {
      console.warn(`[Subscription] Unhandled payment status "${status}" for ${locationId}`);
    }
  } catch (error) {
    console.error(`Payment status handling failed for ${locationId} | ${formatError(error)}`);
  }

  res.json({ ok: true });
}

module.exports = { createWebhooksRouter };
