const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const Phone = require('../schemas/phone.schema');

// GRAMJS_LOG_LEVEL quiets GramJS's chatty update-loop reconnect logging (TIMEOUT /
// Not connected / Started reconnecting) — those are NORMAL churn (Telegram drops idle
// update connections; GramJS auto-reconnects), not failures. Default 'error'. Applied
// per-client via setLogLevel(), which is stable across GramJS versions.
const GRAMJS_LOG_LEVEL = process.env.GRAMJS_LOG_LEVEL || 'error';

const GRAMJS_CONFIG = {
  connectionRetries: 5,
  requestRetries: 3,
  autoReconnect: true,
  retryDelay: 2000,
  floodSleepThreshold: 120,
};

/**
 * v2 MULTI-PHONE: the client pool is keyed by connectionId (the Phone document's _id),
 * NOT by locationId — a location can have many connected phones. Session state lives in
 * Phone docs (collection `phones`), not on Installation.phoneConfig. Every public method
 * that acted on a locationId in v1 now acts on a connectionId.
 */
class ConnectionManager {
  constructor(cryptoService) {
    this.crypto = cryptoService;
    this.clients = new Map();
    this.messageHandlers = new Map();
    this.outgoingHandlers = new Map();

    const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
    const apiHash = process.env.TELEGRAM_API_HASH;
    if (!apiId || !apiHash) {
      console.warn('TELEGRAM_API_ID or TELEGRAM_API_HASH not set — phone login disabled');
      this.disabled = true;
      return;
    }
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.disabled = false;
  }

  // ── Client Lifecycle ─────────────────────────────────

  async connect(connectionId, encryptedSessionString) {
    if (this.disabled) throw new Error('Phone login is not configured on this server');

    // Disconnect existing client if any
    if (this.clients.has(connectionId)) {
      await this.disconnect(connectionId);
    }

    const sessionString = this.crypto.decrypt(encryptedSessionString);
    const session = new StringSession(sessionString);
    const client = new TelegramClient(session, this.apiId, this.apiHash, GRAMJS_CONFIG);

    // Quiet the noisy reconnect churn. Wrapped so a version/API mismatch can't crash connect.
    try {
      if (typeof client.setLogLevel === 'function') client.setLogLevel(GRAMJS_LOG_LEVEL);
    } catch { /* logger API varies by version — best-effort */ }

    try {
      await client.connect();

      // Verify the session is still valid
      const me = await client.getMe();
      console.log(`GramJS connected for connection ${connectionId}: @${me.username || me.id}`);

      this.clients.set(connectionId, { client, connected: true, userId: me.id });

      // Register message handler if one was set before connection
      this._registerEventHandler(connectionId);

      return me;
    } catch (error) {
      // Clean up on failure
      try {
        await client.destroy();
      } catch {
        // ignore cleanup errors
      }

      const msg = error.message || '';

      if (
        msg.includes('AUTH_KEY_UNREGISTERED') ||
        msg.includes('SESSION_REVOKED') ||
        msg.includes('AUTH_KEY_DUPLICATED')
      ) {
        // Session is unusable — revoked (logged out / password change) or the key was
        // invalidated by a duplicate connection. Either way it can't be recovered
        // programmatically. Mark the Phone inactive so the app prompts the owner to
        // reconnect, and stop trying (no retry loop, no reconnect storm).
        console.error(`[Phone] Session unusable for connection ${connectionId} (${msg.split('\n')[0]}) — marking inactive, needs reconnect`);
        await Phone.updateOne({ _id: connectionId }, { isActive: false });
        error.sessionUnusable = true;
      }

      throw error;
    }
  }

  async disconnect(connectionId) {
    const entry = this.clients.get(connectionId);
    if (!entry) return;

    try {
      const sessionString = entry.client.session.save();
      if (sessionString) {
        const encrypted = this.crypto.encrypt(sessionString);
        await Phone.updateOne(
          { _id: connectionId },
          { sessionString: encrypted },
        );
        console.log(`[Phone] Session saved for connection ${connectionId}`);
      }

      await entry.client.destroy();
      console.log(`[Phone] Client disconnected for connection ${connectionId}`);
    } catch (error) {
      console.error(`[Phone] Error disconnecting client for connection ${connectionId}: ${error.message}`);
    }

    this.clients.delete(connectionId);
  }

  async disconnectAll() {
    const connectionIds = Array.from(this.clients.keys());
    console.log(`Disconnecting ${connectionIds.length} GramJS clients...`);

    for (const connectionId of connectionIds) {
      await this.disconnect(connectionId);
    }

    console.log('All GramJS clients disconnected');
  }

  // ── Client Access ────────────────────────────────────

  getClient(connectionId) {
    const entry = this.clients.get(connectionId);
    return entry?.connected ? entry.client : null;
  }

  isConnected(connectionId) {
    const entry = this.clients.get(connectionId);
    return entry?.connected === true;
  }

  // Check if a phone connection exists (in memory OR in the database) for this connectionId.
  async hasPhoneConfig(connectionId) {
    if (!connectionId) return false;
    if (this.isConnected(connectionId)) return true;
    const phone = await Phone.findOne({
      _id: connectionId,
      isActive: true,
      sessionString: { $exists: true, $ne: '' },
    }).lean();
    return !!phone;
  }

  // Does this LOCATION have ANY active phone connection? (location-level fallback)
  async locationHasAnyPhone(locationId) {
    const phone = await Phone.findOne({
      locationId,
      isActive: true,
      sessionString: { $exists: true, $ne: '' },
    }).lean();
    return !!phone;
  }

  // ── Messaging ────────────────────────────────────────

  async sendMessage(connectionId, chatId, text, replyToMessageId) {
    const client = await this._getClientOrThrow(connectionId);
    const result = await client.sendMessage(chatId, {
      message: text,
      ...(replyToMessageId ? { replyTo: replyToMessageId } : {}),
    });
    console.log(`[Phone] Message sent to chat ${chatId} (connection ${connectionId}), msgId=${result.id}`);
    return result.id;
  }

  async sendPhoto(connectionId, chatId, photoUrl, caption) {
    const client = await this._getClientOrThrow(connectionId);
    const result = await client.sendMessage(chatId, {
      file: photoUrl,
      message: caption || '',
    });
    console.log(`[Phone] Photo sent to chat ${chatId} (connection ${connectionId}), msgId=${result.id}`);
    return result.id;
  }

  async sendDocument(connectionId, chatId, documentUrl, caption) {
    const client = await this._getClientOrThrow(connectionId);
    // Let video/audio render natively (player/voice bubble) instead of a file blob.
    // Only force-document for true documents so PDFs/zips/etc. stay as files.
    const isPlayable = /\.(mp4|mov|webm|m4v|mp3|m4a|ogg|oga|wav|aac)(\?|$)/i.test(documentUrl);
    const result = await client.sendMessage(chatId, {
      file: documentUrl,
      message: caption || '',
      ...(isPlayable ? {} : { forceDocument: true }),
    });
    console.log(`[Phone] ${isPlayable ? 'Media' : 'Document'} sent to chat ${chatId} (connection ${connectionId}), msgId=${result.id}`);
    return result.id;
  }

  async downloadMedia(connectionId, media) {
    const client = await this._getClientOrThrow(connectionId);
    return client.downloadMedia(media);
  }

  // ── Advanced Methods ───────────────────────────────────

  async sendReaction(connectionId, chatId, messageId, emoji) {
    const client = await this._getClientOrThrow(connectionId);
    console.log(`[Phone] Sending reaction "${emoji}" to msgId=${messageId} in chat ${chatId} (connection ${connectionId})`);
    await client.invoke(
      new Api.messages.SendReaction({
        peer: chatId,
        msgId: messageId,
        reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
      }),
    );
    console.log(`[Phone] Reaction "${emoji}" sent to msgId=${messageId} in chat ${chatId}`);
    return true;
  }

  async forwardMessage(connectionId, fromChatId, toChatId, messageId) {
    const client = await this._getClientOrThrow(connectionId);
    const result = await client.forwardMessages(toChatId, {
      messages: [messageId],
      fromPeer: fromChatId,
    });
    console.log(`[Phone] Forwarded msgId=${messageId} from chat ${fromChatId} → ${toChatId} (connection ${connectionId}), newMsgId=${result[0]?.id}`);
    return result[0]?.id;
  }

  async editMessage(connectionId, chatId, messageId, text) {
    const client = await this._getClientOrThrow(connectionId);
    await client.editMessage(chatId, { message: messageId, text });
    console.log(`[Phone] Edited msgId=${messageId} in chat ${chatId} (connection ${connectionId})`);
    return true;
  }

  async deleteMessage(connectionId, chatId, messageId) {
    const client = await this._getClientOrThrow(connectionId);
    await client.deleteMessages(chatId, [messageId], { revoke: true });
    console.log(`[Phone] Deleted msgId=${messageId} in chat ${chatId} (connection ${connectionId})`);
    return true;
  }

  async pinMessage(connectionId, chatId, messageId) {
    const client = await this._getClientOrThrow(connectionId);
    await client.pinMessage(chatId, messageId);
    console.log(`[Phone] Pinned msgId=${messageId} in chat ${chatId} (connection ${connectionId})`);
    return true;
  }

  async generateInviteLink(connectionId, chatId) {
    const client = await this._getClientOrThrow(connectionId);
    const peer = await this._resolvePeer(client, chatId);
    const result = await client.invoke(
      new Api.messages.ExportChatInvite({ peer }),
    );
    console.log(`[Phone] Invite link generated for chat ${chatId} (connection ${connectionId}): ${result.link}`);
    return result.link;
  }

  async sendToGroup(connectionId, groupId, text) {
    const client = await this._getClientOrThrow(connectionId);
    const peer = await this._resolvePeer(client, groupId);
    const result = await client.sendMessage(peer, { message: text });
    console.log(`[Phone] Message sent to group ${groupId} (connection ${connectionId}), msgId=${result.id}`);
    return result.id;
  }

  async sendFileToGroup(connectionId, groupId, fileUrl, caption) {
    const client = await this._getClientOrThrow(connectionId);
    const peer = await this._resolvePeer(client, groupId);
    const result = await client.sendMessage(peer, {
      file: fileUrl,
      message: caption || '',
      forceDocument: true,
    });
    console.log(`[Phone] File sent to group ${groupId} (connection ${connectionId}), msgId=${result.id}`);
    return result.id;
  }

  async editGroupPermissions(connectionId, chatId, permissions) {
    const client = await this._getClientOrThrow(connectionId);
    const peer = await this._resolvePeer(client, chatId);
    await client.invoke(
      new Api.messages.EditChatDefaultBannedRights({
        peer,
        bannedRights: new Api.ChatBannedRights({
          untilDate: 0,
          sendMessages: !permissions.sendMessages,
          sendMedia: !permissions.sendMedia,
          sendStickers: !permissions.sendStickers,
          sendGifs: !permissions.sendGifs,
          sendInline: !permissions.sendInline,
          embedLinks: !permissions.embedLinks,
          sendPolls: !permissions.sendPolls,
          changeInfo: !permissions.changeInfo,
          inviteUsers: !permissions.inviteUsers,
          pinMessages: !permissions.pinMessages,
        }),
      }),
    );
    console.log(`[Phone] Group permissions updated for chat ${chatId} (connection ${connectionId})`);
    return true;
  }

  /**
   * Remove (kick) a user from a supergroup/channel via the connected phone account.
   * The account must be an admin with ban rights. We ban (viewMessages:true) to remove
   * them, then lift the ban so it's a kick — they can rejoin, not permanently banned.
   */
  async removeFromGroup(connectionId, groupId, userId) {
    const client = await this._getClientOrThrow(connectionId);
    const channel = await this._resolvePeer(client, groupId);
    const participant = await this._resolvePeer(client, userId);
    await client.invoke(
      new Api.channels.EditBanned({
        channel,
        participant,
        bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true }),
      }),
    );
    // Lift all restrictions so the user is only removed, not permanently banned.
    await client.invoke(
      new Api.channels.EditBanned({
        channel,
        participant,
        bannedRights: new Api.ChatBannedRights({ untilDate: 0 }),
      }),
    );
    console.log(`[Phone] Removed user ${userId} from group ${groupId} (connection ${connectionId})`);
    return true;
  }

  // ── Event Handlers ───────────────────────────────────

  onNewMessage(connectionId, callback) {
    this.messageHandlers.set(connectionId, callback);

    // If client already connected, register immediately
    if (this.clients.has(connectionId)) {
      this._registerEventHandler(connectionId);
    }
  }

  // Register a handler for OUTGOING messages — i.e. messages a human agent sends
  // manually from the native Telegram app using this connected account. Lets us sync
  // agent replies back to GHL and fire a trigger (e.g. to pause the AI bot).
  onOutgoingMessage(connectionId, callback) {
    this.outgoingHandlers.set(connectionId, callback);
    if (this.clients.has(connectionId)) {
      this._registerEventHandler(connectionId);
    }
  }

  _registerEventHandler(connectionId) {
    const entry = this.clients.get(connectionId);
    const handler = this.messageHandlers.get(connectionId);

    if (handler) {
      entry && entry.client.addEventHandler(async (event) => {
        try {
          if (!event.isPrivate) return; // private DMs only
          await handler(event);
        } catch (error) {
          console.error(`Error handling inbound message for connection ${connectionId}:`, error.message);
        }
      }, new NewMessage({ incoming: true }));
    }

    // Outgoing = manual agent replies from the native app on this account.
    const outHandler = this.outgoingHandlers.get(connectionId);
    if (outHandler && entry) {
      entry.client.addEventHandler(async (event) => {
        try {
          if (!event.isPrivate) return; // private DMs only
          await outHandler(event);
        } catch (error) {
          console.error(`Error handling outgoing message for connection ${connectionId}:`, error.message);
        }
      }, new NewMessage({ outgoing: true, incoming: false }));
    }
  }

  // ── Lazy reconnect: restore a single phone connection from its saved session ──

  async _lazyReconnect(connectionId) {
    const phone = await Phone.findOne({
      _id: connectionId,
      isActive: true,
      sessionString: { $exists: true, $ne: '' },
    });

    if (!phone) return null;

    console.log(`[LazyReconnect] Restoring phone connection ${connectionId}...`);
    try {
      await this.connect(connectionId, phone.sessionString);
      console.log(`[LazyReconnect] Phone reconnected for connection ${connectionId}`);
      return this.getClient(connectionId);
    } catch (error) {
      console.error(`[LazyReconnect] Failed for connection ${connectionId}: ${error.message}`);
      return null;
    }
  }

  // ── Internal Helpers ─────────────────────────────────

  async _getClientOrThrow(connectionId) {
    let client = this.getClient(connectionId);

    // Lazy reconnect: if not connected, try to restore from saved session
    if (!client) {
      client = await this._lazyReconnect(connectionId);
    }

    if (!client) {
      const err = new Error(`No active phone connection: ${connectionId}`);
      err.statusCode = 400;
      throw err;
    }
    return client;
  }

  /**
   * Resolve a group/chat identifier (numeric id OR @username) into a proper Telegram
   * entity that GramJS admin calls (EditBanned, EditChatDefaultBannedRights, etc.)
   * require. getEntity handles both a numeric id and a @username; on failure it throws
   * a clear, user-facing error instead of a cryptic RPC error.
   */
  async _resolvePeer(client, identifier) {
    try {
      return await client.getEntity(identifier);
    } catch (err) {
      throw new Error(
        `Could not find the Telegram group "${identifier}". ` +
        `Use the group's @username (public groups) or its numeric ID (e.g. -1001234567890), ` +
        `and make sure the connected account is a member/admin. (${err.message})`,
      );
    }
  }
}

module.exports = ConnectionManager;
