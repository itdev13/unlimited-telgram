const axios = require('axios');
const WorkflowSubscription = require('../schemas/workflow-subscription.schema');
const Bot = require('../schemas/bot.schema');
const Phone = require('../schemas/phone.schema');

/**
 * v2 WORKFLOWS SERVICE. Same 13 triggers + 13 actions as v1, with NO billing (removed
 * chargeFirst entirely — that lives in the router in v1 and is dropped). The multi-
 * connection change is in transport resolution: an action routes out through the SPECIFIC
 * bot/phone the contact last reached us on (mapping.lastConnectionId), falling back to any
 * active connection on the location. ConnectionManager methods are keyed by connectionId.
 */
class WorkflowsService {
  constructor(contactMappingService, connectionService, telegramService, authService, connectionManager, ghlService, subscriptionService) {
    this.contactMapping = contactMappingService;
    this.connections = connectionService;
    this.telegram = telegramService;
    this.auth = authService;
    this.connectionManager = connectionManager;
    this.ghl = ghlService;
    this.subscription = subscriptionService;
  }

  /**
   * Reflect an outbound workflow message in the GHL conversation (best-effort).
   * A workflow send reaches the customer on Telegram but wouldn't appear in the CRM
   * thread unless we push it here. Handles text AND media: pass `attachments` (array of
   * public URLs) so a photo/document-only send still shows up in GHL — otherwise those
   * sends were invisible to the agent. Never throws — a sync failure must not fail the
   * action (the message already sent).
   */
  async _syncOutboundToGhl(locationId, contactId, chatId, text, attachments) {
    const atts = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    if (!this.ghl || !contactId) return;
    if (!text && atts.length === 0) return; // nothing to mirror
    try {
      const Installation = require('../schemas/installation.schema');
      const inst = await Installation.findOne({ locationId }).select('conversationProviderId').lean();
      if (!inst?.conversationProviderId) return;
      await this.ghl.addOutboundMessage(locationId, {
        conversationProviderId: inst.conversationProviderId,
        contactId,
        ...(text ? { message: text } : {}),
        ...(atts.length ? { attachments: atts } : {}),
        altId: String(chatId),
      });
    } catch (err) {
      console.warn(`[Workflows] GHL conversation sync failed (message still sent) for ${locationId}: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // TRIGGER SUBSCRIPTION MANAGEMENT
  // ═══════════════════════════════════════════════════════════

  async handleSubscription(payload) {
    const { triggerData, extras, meta } = payload;
    const { eventType, targetUrl, filters } = triggerData;
    const { locationId, workflowId, companyId } = extras;
    const triggerKey = meta.key;

    console.log(`[Workflows] Subscription ${eventType}: key=${triggerKey}, workflow=${workflowId}, location=${locationId}`);

    switch (eventType) {
      case 'CREATED':
      case 'UPDATED':
        await WorkflowSubscription.findOneAndUpdate(
          { workflowId, triggerKey },
          {
            locationId,
            companyId,
            workflowId,
            triggerKey,
            targetUrl,
            filters: filters || {},
            extras,
            meta,
            status: 'active',
          },
          { upsert: true, returnDocument: 'after' },
        );
        console.log(`Subscription upserted: ${triggerKey} for workflow ${workflowId}`);
        break;

      case 'DELETED':
        await WorkflowSubscription.findOneAndUpdate(
          { workflowId, triggerKey },
          { status: 'deleted' },
        );
        console.log(`Subscription deleted: ${triggerKey} for workflow ${workflowId}`);
        break;

      default:
        console.warn(`Unknown subscription event type: ${eventType}`);
    }

    return { success: true };
  }

  // ═══════════════════════════════════════════════════════════
  // TRIGGER FIRING
  // ═══════════════════════════════════════════════════════════

  async fireTrigger(triggerKey, locationId, eventData) {
    try {
      // TESTING: log the exact payload we send to GHL for this trigger, so you can see
      // what data Telegram gave us and what GHL receives. Toggle with WORKFLOW_DEBUG_PAYLOAD.
      if (process.env.WORKFLOW_DEBUG_PAYLOAD !== 'false') {
        console.log(
          `[Workflows][payload] trigger=${triggerKey} location=${locationId} → GHL payload=${JSON.stringify(eventData)}`,
        );
      }

      const subscriptions = await WorkflowSubscription.find({
        locationId,
        triggerKey,
        status: 'active',
      });

      if (subscriptions.length === 0) {
        console.log(`[Workflows] ${triggerKey} fired but no active subscription for location ${locationId} — nothing sent`);
        return;
      }

      let accessToken = null;
      try {
        accessToken = await this.auth.getAccessToken(locationId);
      } catch (err) {
        console.error(`[Workflows] Cannot get token for trigger ${triggerKey} @ ${locationId}: ${err.message}`);
      }

      const headers = {
        'Content-Type': 'application/json',
        'Version': process.env.GHL_API_VERSION || '2021-07-28',
      };
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

      const results = await Promise.allSettled(
        subscriptions.map((sub) =>
          axios.post(sub.targetUrl, eventData, { headers, timeout: 10000 }),
        ),
      );

      // GHL reports a dead trigger two ways: "trigger with id: <x> is deleted" and
      // "trigger with id: <x> is inactive. skipping execution". Both mean the workflow
      // trigger no longer accepts fires, so we stop firing it. Matching only "deleted"
      // left "inactive" subscriptions firing (and erroring) on every message forever.
      const isTriggerDead = (payload) => {
        const text = JSON.stringify(payload || '').toLowerCase();
        return (
          /trigger with id:.*is deleted/.test(text) ||
          text.includes('trigger is deleted') ||
          /trigger with id:.*is inactive/.test(text) ||
          text.includes('skipping execution')
        );
      };

      for (let i = 0; i < results.length; i++) {
        const sub = subscriptions[i];
        if (results[i].status === 'fulfilled') {
          // A 200 can still carry "trigger is deleted/inactive" in the body — clean it up.
          if (isTriggerDead(results[i].value?.data)) {
            await this._markSubscriptionDeleted(sub, 'GHL reported trigger dead (200 body)');
          } else {
            console.log(`[Workflows] Fired ${triggerKey} → workflow ${sub.workflowId} (location ${locationId})`);
          }
        } else {
          const err = results[i].reason;
          const status = err.response?.status;
          const ghlMsg = err.response?.data?.message || err.response?.data?.error || err.message || 'Unknown error';

          // If GHL says the trigger is deleted OR inactive, stop firing it — mark our
          // subscription deleted so we don't keep hitting a dead workflow trigger.
          if (isTriggerDead(err.response?.data) || /is deleted|is inactive|skipping execution/.test(String(ghlMsg).toLowerCase())) {
            await this._markSubscriptionDeleted(sub, `GHL reported trigger dead: ${ghlMsg}`);
            continue;
          }

          const reason = classifyWorkflowError(status, ghlMsg);
          console.error(
            `[Workflows] Failed to fire ${triggerKey} → workflow ${sub.workflowId} (location ${locationId})\n` +
            `  Status: ${status || 'no-response'}\n` +
            `  Reason: ${reason.label}\n` +
            `  GHL says: ${ghlMsg}\n` +
            `  Action: ${reason.action}`
          );
        }
      }
    } catch (error) {
      console.error(`[Workflows] fireTrigger error for ${triggerKey} @ ${locationId}: ${error.message}`);
    }
  }

  /**
   * Mark a workflow subscription deleted so we stop firing a trigger GHL has already
   * removed. Mirrors what the DELETED subscription webhook does — this is the safety
   * net for when that webhook was missed and GHL rejects the fire as "trigger deleted".
   */
  async _markSubscriptionDeleted(sub, reason) {
    try {
      await WorkflowSubscription.updateOne(
        { _id: sub._id },
        { status: 'deleted' },
      );
      console.warn(`[Workflows] Subscription auto-deleted (${sub.triggerKey} / workflow ${sub.workflowId}) — ${reason}`);
    } catch (err) {
      console.error(`[Workflows] Failed to auto-delete subscription ${sub._id}: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ACTION EXECUTION
  // (transport-agnostic: routes out via the contact's connection, bot or phone)
  // ═══════════════════════════════════════════════════════════

  // GHL sends action inputs in payload.data or payload.inputData depending on version
  _getData(payload) {
    return payload.data || payload.inputData || {};
  }

  /**
   * Accept a Telegram chat/group identifier as either a numeric ID (e.g. -1001234567890)
   * or a public @username (e.g. @mygroup / mygroup). Numeric → Number so the Bot/MTProto
   * APIs get the real chat id; username → the string as-is (Telegram resolves it).
   * Private groups have no username, so those must use the numeric ID.
   */
  _normalizeChatId(value) {
    const s = String(value).trim();
    if (/^-?\d+$/.test(s)) return Number(s); // numeric id (groups are negative)
    return s.startsWith('@') ? s : `@${s}`; // normalize username to @form
  }

  async executeSendMessage(payload) {
    const { locationId, contactId } = payload.extras;
    const { message, photoUrl, documentUrl, caption } = this._getData(payload);
    if (!message && !photoUrl && !documentUrl) throw new Error('At least one of message, photoUrl, or documentUrl is required');

    const { chatId, transport, botToken, connectionId } = await this._resolve(locationId, contactId);
    let messageId;

    if (transport === 'phone') {
      if (message) messageId = await this.connectionManager.sendMessage(connectionId, chatId, message);
      if (photoUrl) messageId = await this.connectionManager.sendPhoto(connectionId, chatId, photoUrl, caption);
      if (documentUrl) messageId = await this.connectionManager.sendDocument(connectionId, chatId, documentUrl, caption);
    } else {
      if (message) messageId = await this.telegram.sendMessage(botToken, chatId, message);
      if (photoUrl) messageId = await this.telegram.sendPhoto(botToken, chatId, photoUrl, caption || undefined);
      if (documentUrl) messageId = await this.telegram.sendDocument(botToken, chatId, documentUrl, caption || undefined);
    }

    console.log(`Workflow action [${transport}]: sent to chat ${chatId}, messageId=${messageId}`);

    // Mirror the outbound into the GHL conversation so the CRM thread is complete —
    // including photo/document sends. Caption becomes the message text when present.
    const attachments = [photoUrl, documentUrl].filter(Boolean);
    await this._syncOutboundToGhl(locationId, contactId, chatId, message || caption || '', attachments);

    return { messageId, status: 'sent', telegramChatId: chatId };
  }

  async executeSendButtons(payload) {
    const { locationId, contactId } = payload.extras;
    const { message } = this._getData(payload);
    let { buttons } = this._getData(payload);

    if (!message) throw new Error('Message text is required');
    if (!buttons) throw new Error('Buttons field is required');

    // GHL sends the buttons field as a string. If it's a JSON array, use it as-is:
    //   [{"text":"Visit","url":"https://example.com"}]
    // Otherwise treat the raw string as a URL and build a single "Click" button.
    if (typeof buttons === 'string') {
      const raw = buttons.trim();
      try {
        buttons = JSON.parse(raw);
      } catch {
        buttons = [{ text: 'Click', url: raw }];
        console.log(`[Workflows] Buttons field was a plain string — auto-built a single "Click" button: ${raw}`);
      }
    }

    if (!Array.isArray(buttons)) {
      throw new Error('The Buttons field must be a JSON array of button objects, e.g. [{"text":"Visit","url":"https://example.com"}].');
    }

    const { chatId, transport, botToken, connectionId } = await this._resolve(locationId, contactId);

    // Inline keyboards are a Bot API feature. If this contact reached us via the
    // PHONE account (the bot has no chat with them), we can't send inline buttons —
    // so send the message with the button URLs appended as plain links instead.
    if (transport === 'phone') {
      const links = buttons
        .flat()
        .filter((btn) => btn && btn.url)
        .map((btn) => `${btn.text || 'Link'}: ${btn.url}`);
      const text = links.length ? `${message}\n\n${links.join('\n')}` : message;
      const messageId = await this.connectionManager.sendMessage(connectionId, chatId, text);
      console.log(`Workflow action [phone]: sent buttons-as-links to chat ${chatId}, messageId=${messageId}`);
      await this._syncOutboundToGhl(locationId, contactId, chatId, text);
      return { messageId, status: 'sent', telegramChatId: chatId };
    }

    if (!botToken) throw new Error('Send Buttons requires a bot or phone connection.');

    const inlineKeyboard = buttons.map((row) => {
      const rowButtons = Array.isArray(row) ? row : [row];
      return rowButtons.map((btn) => ({
        text: btn.text,
        ...(btn.url ? { url: btn.url } : { callback_data: btn.callbackData || btn.text }),
      }));
    });

    const messageId = await this.telegram.sendMessageWithButtons(botToken, chatId, message, inlineKeyboard);
    console.log(`Workflow action [bot]: sent buttons to chat ${chatId}, messageId=${messageId}`);
    // Mirror to GHL. Inline keyboards don't render in the CRM thread, so append the
    // button labels/URLs as readable lines so the agent sees what the contact received.
    const buttonLines = buttons
      .flat()
      .filter((btn) => btn && btn.text)
      .map((btn) => (btn.url ? `${btn.text}: ${btn.url}` : btn.text));
    const ghlText = buttonLines.length ? `${message}\n\n${buttonLines.join('\n')}` : message;
    await this._syncOutboundToGhl(locationId, contactId, chatId, ghlText);
    return { messageId, status: 'sent', telegramChatId: chatId };
  }

  async executeForwardMessage(payload) {
    const { locationId, contactId } = payload.extras;
    const { fromChatId, messageId: srcMessageId } = this._getData(payload);
    if (!fromChatId || !srcMessageId) throw new Error('fromChatId and messageId are required');

    const { chatId, transport, botToken, connectionId } = await this._resolve(locationId, contactId);
    let messageId;

    if (transport === 'phone') {
      messageId = await this.connectionManager.forwardMessage(connectionId, Number(fromChatId), chatId, Number(srcMessageId));
    } else {
      messageId = await this.telegram.forwardMessage(botToken, chatId, fromChatId, srcMessageId);
    }

    console.log(`Workflow action [${transport}]: forwarded msgId=${srcMessageId} to chat ${chatId}`);
    return { messageId, status: 'sent', telegramChatId: chatId };
  }

  async executeEditMessage(payload) {
    const { locationId, contactId } = payload.extras;
    const { messageId: targetMessageId, message } = this._getData(payload);
    if (!targetMessageId || !message) throw new Error('messageId and message are required');

    const { chatId, transport, botToken, connectionId } = await this._resolve(locationId, contactId);

    if (transport === 'phone') {
      await this.connectionManager.editMessage(connectionId, chatId, Number(targetMessageId), message);
    } else {
      await this.telegram.editMessage(botToken, chatId, targetMessageId, message);
    }

    console.log(`Workflow action [${transport}]: edited message ${targetMessageId} in chat ${chatId}`);
    return { messageId: targetMessageId, status: 'edited', telegramChatId: chatId };
  }

  async executeDeleteMessage(payload) {
    const { locationId, contactId } = payload.extras;
    const { messageId: targetMessageId } = this._getData(payload);
    if (!targetMessageId) throw new Error('messageId is required');

    const { chatId, transport, botToken, connectionId } = await this._resolve(locationId, contactId);

    if (transport === 'phone') {
      await this.connectionManager.deleteMessage(connectionId, chatId, Number(targetMessageId));
    } else {
      await this.telegram.deleteMessage(botToken, chatId, targetMessageId);
    }

    console.log(`Workflow action [${transport}]: deleted message ${targetMessageId} in chat ${chatId}`);
    return { status: 'deleted', telegramChatId: chatId };
  }

  async executeSendPhoneMessage(payload) {
    const { locationId, contactId } = payload.extras;
    const { message } = this._getData(payload);
    if (!message) throw new Error('Message text is required');

    const { chatId, transport, botToken, connectionId } = await this._resolve(locationId, contactId);
    let messageId;

    if (transport === 'phone') {
      messageId = await this.connectionManager.sendMessage(connectionId, chatId, message);
    } else {
      messageId = await this.telegram.sendMessage(botToken, chatId, message);
    }

    console.log(`Workflow action [${transport}]: sent message to chat ${chatId}, messageId=${messageId}`);
    await this._syncOutboundToGhl(locationId, contactId, chatId, message);
    return { messageId, status: 'sent', telegramChatId: chatId };
  }

  async executeSendToGroup(payload) {
    const { locationId } = payload.extras;
    const { groupId, message, fileUrl, caption } = this._getData(payload);
    if (!groupId) throw new Error('groupId is required');
    if (!message && !fileUrl) throw new Error('At least one of message or fileUrl is required');

    const chat = this._normalizeChatId(groupId);
    const { transport, botToken, connectionId } = await this._resolveTransport(locationId);
    let messageId;

    if (transport === 'phone') {
      if (message) messageId = await this.connectionManager.sendToGroup(connectionId, chat, message);
      if (fileUrl) messageId = await this.connectionManager.sendFileToGroup(connectionId, chat, fileUrl, caption || '');
    } else {
      if (message) messageId = await this.telegram.sendMessage(botToken, chat, message);
      if (fileUrl) messageId = await this.telegram.sendDocument(botToken, chat, fileUrl, caption || undefined);
    }

    console.log(`Workflow action [${transport}]: sent to group ${groupId}, messageId=${messageId}`);
    return { messageId, status: 'sent', groupId };
  }

  /**
   * Remove a user from a Telegram group/supergroup. Use for automations like "plan
   * cancelled" or "spam detected". Requires the bot (or connected phone account) to be
   * an admin with ban rights. This is a kick — the user is removed but can rejoin
   * later (e.g. via an invite link). It does NOT permanently ban them.
   */
  async executeRemoveFromGroup(payload) {
    const { locationId, contactId } = payload.extras;
    const data = this._getData(payload);
    const groupId = data.groupId || data.group_id;
    let userId = data.userId || data.user_id || data.telegramUserId;

    // TESTING: log exactly what GHL sent us for this action.
    console.log(
      `[Action:remove-from-group][payload] location=${locationId} contactId=${contactId} ` +
      `data=${JSON.stringify(data)}`,
    );

    if (!groupId) throw new Error('groupId is required — the group ID (e.g. -1001234567890) or @username.');

    // If no explicit userId is given, remove the WORKFLOW'S CONTACT — resolve their
    // Telegram ID from the stored mapping, exactly like Send Message does. This covers
    // the common "this contact cancelled → remove them" case with no manual input.
    // An explicit userId still wins (for removing an arbitrary group member).
    let userIdSource = userId ? 'input' : 'none';
    if (!userId && contactId) {
      const mapping = await this.contactMapping.getContactMapping(locationId, contactId);
      // Prefer the stored telegramUserId (the person). Only fall back to telegramChatId
      // when it's a real user id — i.e. a 1:1 DM (positive). A negative chatId is a group
      // and must NOT be used as the user to remove.
      if (mapping?.telegramUserId) {
        userId = mapping.telegramUserId;
        userIdSource = 'contact-mapping (userId)';
      } else if (mapping?.telegramChatId && mapping.telegramChatId > 0) {
        userId = mapping.telegramChatId;
        userIdSource = 'contact-mapping (dm chatId)';
      }
    }
    if (!userId) {
      throw new Error('Could not determine who to remove — the contact has no Telegram mapping. Provide a User ID, or use a contact who has messaged on Telegram.');
    }

    // Guard: a Telegram USER id is always positive. A negative value (e.g. -100…) is a
    // GROUP/channel id — a common mistake (mapping a group's chatId into User ID). Reject
    // it with a clear message instead of Telegram's cryptic CHANNEL_ADD_INVALID.
    if (/^-/.test(String(userId).trim())) {
      throw new Error(
        `User ID "${userId}" looks like a group ID (negative), not a member's user ID. ` +
        `Leave User ID empty to remove the workflow's contact, or map the member's Telegram user ID (a positive number, e.g. 1582182656).`,
      );
    }

    console.log(
      `[Action:remove-from-group][resolved] group=${groupId} userId=${userId} (from ${userIdSource})`,
    );

    const chat = this._normalizeChatId(groupId);
    const member = this._normalizeChatId(userId);
    const { transport, botToken, connectionId } = await this._resolveTransport(locationId);

    if (transport === 'phone') {
      await this.connectionManager.removeFromGroup(connectionId, chat, member);
    } else {
      await this.telegram.removeChatMember(botToken, chat, member);
    }

    console.log(`Workflow action [${transport}]: removed user ${userId} from group ${groupId}`);
    return { status: 'removed', groupId, userId };
  }

  /**
   * Acknowledge an inline-button tap. Pairs with the telegram_button_clicked trigger:
   * pass the callbackQueryId from the trigger output, optionally a toast message.
   * Bot-only (callback queries are a Bot API concept).
   */
  async executeAnswerCallback(payload) {
    const { locationId, contactId } = payload.extras;
    const data = this._getData(payload);
    const callbackQueryId = data.callbackQueryId || data.callback_query_id;
    const text = data.text || '';
    const showAlert = data.showAlert === true || data.showAlert === 'true';
    if (!callbackQueryId) throw new Error('callbackQueryId is required — pass it from the Telegram Button Clicked trigger output.');

    // Answer via the bot that owns this contact's conversation, falling back to any bot.
    const botToken = await this._resolveBotTokenForContact(locationId, contactId);
    if (!botToken) throw new Error('Answer Callback requires a bot connection.');

    await this.telegram.answerCallbackQuery(botToken, callbackQueryId, text || undefined, showAlert);
    return { status: 'answered' };
  }

  async executeSendReaction(payload) {
    const { locationId, contactId } = payload.extras;

    // GHL may send action inputs in payload.data or payload.inputData
    const data = payload.data || payload.inputData || {};
    const targetMessageId = data.messageId || data.message_id;
    const emoji = data.emoji;

    console.log(`[Workflows] send-reaction inputs: messageId=${targetMessageId} (${typeof targetMessageId}), emoji=${emoji} | raw.data=${JSON.stringify(payload.data)} raw.inputData=${JSON.stringify(payload.inputData)}`);

    if (!targetMessageId) throw new Error('messageId is required — pass the Telegram message ID to react to (e.g. from trigger output telegramMessageId)');
    if (!emoji) throw new Error('emoji is required — pass a valid Telegram reaction emoji (e.g. ❤️)');

    const parsedMessageId = Number(targetMessageId);
    if (!parsedMessageId || isNaN(parsedMessageId)) throw new Error(`messageId must be a valid number, got: "${targetMessageId}"`);

    const { chatId, transport, botToken, connectionId } = await this._resolve(locationId, contactId);

    if (transport === 'phone') {
      await this.connectionManager.sendReaction(connectionId, chatId, parsedMessageId, emoji);
    } else {
      await this.telegram.sendReaction(botToken, chatId, parsedMessageId, emoji);
    }

    console.log(`Workflow action [${transport}]: reacted ${emoji} to message ${targetMessageId}`);
    return { status: 'reacted', emoji, telegramChatId: chatId };
  }

  async executeGenerateInviteLink(payload) {
    const { locationId, contactId } = payload.extras;
    const { groupId } = this._getData(payload);
    if (!groupId) throw new Error('groupId is required — a public group @username, or the numeric ID (e.g. -1001234567890) for private groups.');

    const chat = this._normalizeChatId(groupId);

    // Step 1: generate the link (we always need the transport/botToken for the group action)
    const { transport, botToken, connectionId } = await this._resolveTransport(locationId);
    let inviteLink;
    if (transport === 'phone') {
      inviteLink = await this.connectionManager.generateInviteLink(connectionId, chat);
    } else {
      inviteLink = await this.telegram.generateInviteLink(botToken, chat);
    }
    console.log(`Workflow action [${transport}]: generated invite link for group ${groupId}`);

    // Step 2: deliver the link to the triggering contact.
    // Failure to deliver must not hide the generated link — callers that chain the action still use the return value.
    let delivered = false;
    let deliveryError = null;
    if (contactId) {
      try {
        const resolved = await this._resolve(locationId, contactId);
        const text = `Here's your invite link to join the group:\n${inviteLink}`;
        if (resolved.transport === 'phone') {
          await this.connectionManager.sendMessage(resolved.connectionId, resolved.chatId, text);
        } else {
          await this.telegram.sendMessage(resolved.botToken, resolved.chatId, text);
        }
        delivered = true;
        console.log(`Workflow action [${resolved.transport}]: delivered invite link to contact ${contactId}`);
        // Mirror the delivered link into the GHL conversation so the thread shows it.
        await this._syncOutboundToGhl(locationId, contactId, resolved.chatId, text);
      } catch (err) {
        deliveryError = err.message;
        console.error(`Workflow action: failed to deliver invite link to contact ${contactId}: ${err.message}`);
      }
    }

    return { inviteLink, delivered, deliveryError, status: 'generated', groupId };
  }

  async executePinMessage(payload) {
    const { locationId, contactId } = payload.extras;
    const { messageId: targetMessageId } = this._getData(payload);
    if (!targetMessageId) throw new Error('messageId is required — pass the numeric Telegram message ID (e.g. from trigger output telegramMessageId)');

    const parsedMessageId = Number(targetMessageId);
    if (!parsedMessageId || isNaN(parsedMessageId)) throw new Error(`messageId must be a valid number, got: "${targetMessageId}"`);

    const { chatId, transport, botToken, connectionId } = await this._resolve(locationId, contactId);

    if (transport === 'phone') {
      await this.connectionManager.pinMessage(connectionId, chatId, parsedMessageId);
    } else {
      await this.telegram.pinMessage(botToken, chatId, parsedMessageId);
    }

    console.log(`Workflow action [${transport}]: pinned message ${targetMessageId} in chat ${chatId}`);
    return { status: 'pinned', telegramChatId: chatId };
  }

  async executeEditGroupPermissions(payload) {
    const { locationId } = payload.extras;
    const data = this._getData(payload);
    const { groupId } = data;
    if (!groupId) throw new Error('groupId is required');

    // Permissions can arrive two ways:
    //  1. a nested `permissions` object (JSON field), or
    //  2. flat toggle fields the dashboard sends (sendMessages, sendMedia, …).
    // Support both. Toggles come as booleans or "true"/"false" strings.
    const asBool = (v) => v === true || v === 'true';
    const toggleKeys = [
      'sendMessages', 'sendMedia', 'sendStickers', 'sendGifs', 'sendInline',
      'embedLinks', 'sendPolls', 'changeInfo', 'inviteUsers', 'pinMessages',
    ];
    let permissions = data.permissions;
    if (!permissions) {
      permissions = {};
      for (const k of toggleKeys) {
        if (data[k] !== undefined) permissions[k] = asBool(data[k]);
      }
    }
    if (Object.keys(permissions).length === 0) {
      throw new Error('At least one permission toggle is required.');
    }

    const chat = this._normalizeChatId(groupId);
    const { transport, botToken, connectionId } = await this._resolveTransport(locationId);

    if (transport === 'phone') {
      await this.connectionManager.editGroupPermissions(connectionId, chat, permissions);
    } else {
      await this.telegram.setChatPermissions(botToken, chat, permissions);
    }

    console.log(`Workflow action [${transport}]: edited group permissions for ${groupId}`);
    return { status: 'updated', groupId };
  }

  // ═══════════════════════════════════════════════════════════
  // HELPERS (v2 multi-connection transport resolution)
  // ═══════════════════════════════════════════════════════════

  /**
   * Resolve a contact's chatId + the SPECIFIC connection to send through. v2: prefer the
   * connection the contact last reached us on (mapping.lastConnectionId), so a reply goes
   * back out on the same bot/phone. Fall back to any active connection matching the
   * mapping's source, then to any active connection on the location.
   * Returns { chatId, transport, botToken, connectionId }.
   */
  async _resolve(locationId, contactId) {
    const mapping = await this.contactMapping.getContactMapping(locationId, contactId);
    if (!mapping) throw new Error('Contact has no Telegram mapping. The user must message first.');

    const chatId = mapping.telegramChatId;
    const source = mapping.source || 'bot';
    const lastConnectionId = mapping.lastConnectionId || mapping.connectionId || '';

    // 1) Try the exact connection the contact last used.
    if (lastConnectionId) {
      const phone = await Phone.findOne({ _id: lastConnectionId, locationId, isActive: true }).lean().catch(() => null);
      if (phone) {
        return { chatId, transport: 'phone', botToken: null, connectionId: String(phone._id) };
      }
      const bot = await Bot.findOne({ _id: lastConnectionId, locationId, isActive: true }).lean().catch(() => null);
      if (bot) {
        const botToken = await this.connections.getBotTokenById(locationId, String(bot._id));
        return { chatId, transport: 'bot', botToken, connectionId: String(bot._id) };
      }
    }

    // 2) Fall back by source, then any available connection on the location.
    if (source === 'phone') {
      const phone = await Phone.findOne({ locationId, isActive: true }).sort({ lastActivityAt: -1 }).lean();
      if (phone) return { chatId, transport: 'phone', botToken: null, connectionId: String(phone._id) };
    }
    const anyBot = await this.connections.getAnyActiveBot(locationId);
    if (anyBot) return { chatId, transport: 'bot', botToken: anyBot.botToken, connectionId: anyBot.id };

    const anyPhone = await Phone.findOne({ locationId, isActive: true }).sort({ lastActivityAt: -1 }).lean();
    if (anyPhone) return { chatId, transport: 'phone', botToken: null, connectionId: String(anyPhone._id) };

    throw new Error('No Telegram connection configured. Connect a bot or phone in settings.');
  }

  /**
   * Resolve a transport + connection for a location-level (group) action with no contact.
   * Prefers any active bot, else any active phone.
   * Returns { transport, botToken, connectionId }.
   */
  async _resolveTransport(locationId) {
    const anyBot = await this.connections.getAnyActiveBot(locationId);
    if (anyBot) return { transport: 'bot', botToken: anyBot.botToken, connectionId: anyBot.id };

    const anyPhone = await Phone.findOne({ locationId, isActive: true }).sort({ lastActivityAt: -1 }).lean();
    if (anyPhone) return { transport: 'phone', botToken: null, connectionId: String(anyPhone._id) };

    throw new Error('No Telegram connection configured. Connect a bot or phone in settings.');
  }

  // Resolve the bot token for a contact (for bot-only actions like Answer Callback).
  async _resolveBotTokenForContact(locationId, contactId) {
    if (contactId) {
      const mapping = await this.contactMapping.getContactMapping(locationId, contactId);
      const lastConnectionId = mapping?.lastConnectionId || mapping?.connectionId || '';
      if (lastConnectionId) {
        const token = await this.connections.getBotTokenById(locationId, lastConnectionId);
        if (token) return token;
      }
    }
    const anyBot = await this.connections.getAnyActiveBot(locationId);
    return anyBot ? anyBot.botToken : null;
  }
}

/**
 * Classify a GHL workflow trigger failure into a user-actionable reason.
 * GHL surfaces a wide variety of error messages — this maps the common ones
 * into a label + action so logs are readable at a glance.
 */
function classifyWorkflowError(status, message = '') {
  const msg = String(message).toLowerCase();
  if (msg.includes('premium action') && (msg.includes('does not have enough funds') || msg.includes('billing'))) {
    return {
      label: 'GHL Premium Action billing failed',
      action: 'Customer needs to top up Premium Action credits in GHL (Settings → Billing → Premium Action Pricing). This is GHL workflow billing, NOT our app subscription.'
    };
  }
  if (msg.includes('does not have enough funds') || msg.includes('insufficient')) {
    return {
      label: 'GHL company funds insufficient',
      action: 'Customer needs to add funds to the GHL company wallet for the failing premium step.'
    };
  }
  if (status === 401 || status === 403 || msg.includes('unauthorized') || msg.includes('forbidden')) {
    return {
      label: 'Auth rejected by GHL',
      action: 'OAuth token may be expired or revoked. Verify the install is still active.'
    };
  }
  if (status === 404 || msg.includes('not found') || msg.includes('workflow does not exist')) {
    return {
      label: 'Workflow not found',
      action: 'Workflow was deleted or unpublished in GHL. Remove the stale subscription from workflow_subscriptions.'
    };
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many')) {
    return {
      label: 'GHL rate limit hit',
      action: 'Throttle outbound trigger fires. Will retry on next inbound message.'
    };
  }
  if (status === 408 || msg.includes('timeout') || msg.includes('timed out')) {
    return {
      label: 'Request to GHL timed out',
      action: 'GHL took >10s to respond. Likely transient — next inbound message will retry.'
    };
  }
  if (status >= 500) {
    return {
      label: 'GHL server error',
      action: 'Transient GHL outage — next inbound message will retry. If persistent, check GHL status page.'
    };
  }
  if (!status) {
    return {
      label: 'No response from GHL',
      action: 'Network error or DNS failure reaching the trigger URL. Check connectivity.'
    };
  }
  return {
    label: `GHL returned ${status}`,
    action: 'Inspect the GHL response message above. Not a known billing/auth/rate issue.'
  };
}

module.exports = WorkflowsService;
