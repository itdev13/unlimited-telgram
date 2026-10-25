const axios = require('axios');

const TELEGRAM_API = 'https://api.telegram.org';

class TelegramService {
  constructor() {
    this.backendUrl = process.env.BACKEND_URL;
    if (!this.backendUrl) throw new Error('BACKEND_URL is required');
  }

  // ── Bot Validation ─────────────────────────────────────────

  async validateBotToken(botToken) {
    try {
      const res = await axios.get(`${TELEGRAM_API}/bot${botToken}/getMe`);
      return res.data.result;
    } catch (error) {
      if (error.response?.status === 401) {
        const err = new Error(
          'Invalid bot token. Please check the token from BotFather and try again.',
        );
        err.statusCode = 400;
        throw err;
      }
      const err = new Error('Could not reach Telegram. Please try again.');
      err.statusCode = 400;
      throw err;
    }
  }

  // ── Webhook Management ─────────────────────────────────────

  // v2 multi-bot: the webhook path carries BOTH the locationId and the bot's _id, so an
  // inbound update can be routed to the exact Bot doc it belongs to (many bots per location).
  async setWebhook(botToken, locationId, botId, webhookSecret) {
    const webhookUrl = `${this.backendUrl}/webhooks/telegram/${locationId}/${botId}`;

    const res = await axios.post(`${TELEGRAM_API}/bot${botToken}/setWebhook`, {
      url: webhookUrl,
      secret_token: webhookSecret,
      // callback_query: inline-button taps. my_chat_member: the bot's own status in a
      // chat (blocked/unblocked, added/removed). chat_member: other members joining/
      // leaving a group the bot administers (requires the bot to be an admin to receive).
      allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member', 'chat_member'],
      drop_pending_updates: false,
    });

    if (!res.data.ok) {
      const err = new Error(`Failed to set Telegram webhook: ${res.data.description}`);
      err.statusCode = 400;
      throw err;
    }

    console.log(`Webhook set for location ${locationId} / bot ${botId}: ${webhookUrl}`);
  }

  async deleteWebhook(botToken) {
    try {
      await axios.post(`${TELEGRAM_API}/bot${botToken}/deleteWebhook`, {
        drop_pending_updates: true,
      });
      console.log('Telegram webhook deleted');
    } catch (error) {
      console.warn('Failed to delete Telegram webhook (may already be removed)');
    }
  }

  async getWebhookInfo(botToken) {
    const res = await axios.get(`${TELEGRAM_API}/bot${botToken}/getWebhookInfo`);
    return res.data.result;
  }

  // ── Send Messages ──────────────────────────────────────────

  async sendMessage(botToken, chatId, text, replyToMessageId) {
    const res = await this._callTelegramApi(botToken, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(replyToMessageId ? { reply_parameters: { message_id: Number(replyToMessageId) } } : {}),
    });
    return res.result.message_id;
  }

  async sendPhoto(botToken, chatId, photoUrl, caption) {
    const res = await this._callTelegramApi(botToken, 'sendPhoto', {
      chat_id: chatId,
      photo: photoUrl,
      caption,
    });
    return res.result.message_id;
  }

  async sendDocument(botToken, chatId, documentUrl, caption) {
    const res = await this._callTelegramApi(botToken, 'sendDocument', {
      chat_id: chatId,
      document: documentUrl,
      caption,
    });
    return res.result.message_id;
  }

  /**
   * Upload a file to Telegram from raw bytes (multipart), instead of handing Telegram a
   * URL and hoping it can fetch it. Needed for GHL-hosted attachments on private/internal
   * URLs that Telegram's servers can't reach ("failed to get HTTP URL content").
   * `method` is sendPhoto/sendDocument/sendAudio/sendVoice; `field` is the matching file
   * field (photo/document/audio/voice).
   */
  async sendFileBuffer(botToken, chatId, { method, field, buffer, filename, mimeType, caption }) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append(field, new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename || 'file');

    const res = await axios.post(`${TELEGRAM_API}/bot${botToken}/${method}`, form);
    if (!res.data.ok) {
      const err = new Error(`Telegram ${method} failed: ${res.data.description}`);
      err.response = { status: 400, data: res.data };
      throw err;
    }
    return res.data.result.message_id;
  }

  // ── Advanced Send Methods ─────────────────────────────────

  async sendMessageWithButtons(botToken, chatId, text, inlineKeyboard) {
    const res = await this._callTelegramApi(botToken, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
    return res.result.message_id;
  }

  async forwardMessage(botToken, toChatId, fromChatId, messageId) {
    const res = await this._callTelegramApi(botToken, 'forwardMessage', {
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    });
    return res.result.message_id;
  }

  async editMessage(botToken, chatId, messageId, text) {
    const res = await this._callTelegramApi(botToken, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    });
    return res.result.message_id;
  }

  async deleteMessage(botToken, chatId, messageId) {
    await this._callTelegramApi(botToken, 'deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
    return true;
  }

  async pinMessage(botToken, chatId, messageId) {
    await this._callTelegramApi(botToken, 'pinChatMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
    return true;
  }

  // Acknowledge an inline-button tap so the client's loading spinner clears. Optional
  // `text` shows a small toast/alert to the user. Best-effort — callbacks expire ~15min.
  async answerCallbackQuery(botToken, callbackQueryId, text, showAlert = false) {
    await this._callTelegramApi(botToken, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
      ...(showAlert ? { show_alert: true } : {}),
    });
    return true;
  }

  async sendReaction(botToken, chatId, messageId, emoji) {
    await this._callTelegramApi(botToken, 'setMessageReaction', {
      chat_id: chatId,
      message_id: Number(messageId),
      reaction: [{ type: 'emoji', emoji }],
    });
    return true;
  }

  async generateInviteLink(botToken, chatId) {
    const res = await this._callTelegramApi(botToken, 'exportChatInviteLink', {
      chat_id: chatId,
    });
    return res.result;
  }

  async setChatPermissions(botToken, chatId, permissions) {
    await this._callTelegramApi(botToken, 'setChatPermissions', {
      chat_id: chatId,
      permissions: {
        can_send_messages: permissions.sendMessages ?? true,
        can_send_photos: permissions.sendMedia ?? true,
        can_send_videos: permissions.sendMedia ?? true,
        can_send_documents: permissions.sendMedia ?? true,
        can_send_other_messages: permissions.sendStickers ?? true,
        can_add_web_page_previews: permissions.embedLinks ?? true,
        can_send_polls: permissions.sendPolls ?? true,
        can_change_info: permissions.changeInfo ?? false,
        can_invite_users: permissions.inviteUsers ?? true,
        can_pin_messages: permissions.pinMessages ?? true,
      },
    });
    return true;
  }

  /**
   * Remove (kick) a user from a group/supergroup. The bot must be an admin with the
   * "ban users" permission. We banChatMember to remove them, then immediately
   * unbanChatMember so they are NOT permanently banned — they can rejoin later.
   */
  async removeChatMember(botToken, chatId, userId) {
    await this._callTelegramApi(botToken, 'banChatMember', {
      chat_id: chatId,
      user_id: userId,
    });
    // Lift the ban right away — this is a kick, not a permanent ban.
    await this._callTelegramApi(botToken, 'unbanChatMember', {
      chat_id: chatId,
      user_id: userId,
      only_if_banned: true,
    });
    return true;
  }

  // ── File Downloads ─────────────────────────────────────────

  // Download a file's bytes server-side. We never hand the file URL to GHL because
  // it embeds the bot token and expires after ~1 hour. Bot API caps downloads at 20 MB.
  async downloadFile(botToken, fileId) {
    const res = await axios.get(`${TELEGRAM_API}/bot${botToken}/getFile?file_id=${fileId}`);
    const filePath = res.data.result.file_path;
    const file = await axios.get(`${TELEGRAM_API}/file/bot${botToken}/${filePath}`, {
      responseType: 'arraybuffer',
    });
    return { buffer: Buffer.from(file.data), filePath };
  }

  // ── Internal Helper ────────────────────────────────────────

  async _callTelegramApi(botToken, method, data, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await axios.post(`${TELEGRAM_API}/bot${botToken}/${method}`, data);
        return res.data;
      } catch (error) {
        const status = error.response?.status;

        // Don't retry on client errors (except 429 rate limit)
        if (status && status >= 400 && status < 500 && status !== 429) {
          const description = error.response?.data?.description || 'no description';
          console.error(`[TelegramService] ${method} failed ${status}: ${description} | payload=${JSON.stringify(data)}`);
          throw error;
        }

        // Rate limited — wait and retry
        if (status === 429) {
          const retryAfter = error.response?.data?.parameters?.retry_after || 5;
          console.warn(
            `Telegram rate limited, waiting ${retryAfter}s (attempt ${attempt}/${retries})`,
          );
          await this._sleep(retryAfter * 1000);
          continue;
        }

        // Transient error — exponential backoff
        if (attempt < retries) {
          const delay = Math.pow(2, attempt) * 1000;
          console.warn(
            `Telegram API error, retrying in ${delay}ms (attempt ${attempt}/${retries})`,
          );
          await this._sleep(delay);
        } else {
          throw error;
        }
      }
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = TelegramService;
