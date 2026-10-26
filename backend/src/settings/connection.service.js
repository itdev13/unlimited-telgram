const Bot = require('../schemas/bot.schema');
const Phone = require('../schemas/phone.schema');
const Installation = require('../schemas/installation.schema');
const CompanyLocation = require('../schemas/company-location.schema');
const PhoneAuthSession = require('../schemas/phone-auth-session.schema');

/**
 * v2 CONNECTION SERVICE. Replaces v1's settings.service, adapted for MULTI-BOT /
 * MULTI-PHONE: bots and phones live in their own collections (many per location) rather
 * than as embedded subdocuments on Installation. Enforces the subscription plan's
 * bot/phone limits (402) on connect, and ensures the GHL Telegram custom fields exist.
 *
 * Phone AUTH itself (send-code / verify-code / 2fa) stays in GramJsService, which writes
 * the Phone doc on completion; this service only enforces the limit before auth starts
 * and handles disconnect.
 */
class ConnectionService {
  constructor(cryptoService, telegramService, authService, ghlService, subscriptionService, connectionManager) {
    this.crypto = cryptoService;
    this.telegram = telegramService;
    this.authService = authService;
    this.ghlService = ghlService;
    this.subscription = subscriptionService;
    this.connectionManager = connectionManager;
  }

  // ── Listing ──────────────────────────────────────────

  async listConnections(locationId) {
    const [bots, phones] = await Promise.all([
      Bot.find({ locationId }).sort({ createdAt: 1 }).lean(),
      Phone.find({ locationId }).sort({ createdAt: 1 }).lean(),
    ]);

    return {
      bots: bots.map((b) => ({
        id: String(b._id),
        botId: b.botId ? String(b.botId) : null,
        username: b.botUsername || '',
        label: b.label || '',
        isActive: !!b.isActive,
        lastActivityAt: b.lastActivityAt || null,
        connectedAt: b.createdAt,
      })),
      phones: phones.map((p) => ({
        id: String(p._id),
        phoneNumber: p.phoneNumber,
        telegramUsername: p.telegramUsername || '',
        displayName: p.displayName || '',
        label: p.label || '',
        isActive: !!p.isActive,
        // An inactive phone means Telegram revoked the session — the owner must reconnect.
        sessionExpired: !p.isActive,
        lastActivityAt: p.lastActivityAt || null,
        connectedAt: p.createdAt,
      })),
    };
  }

  // ── Limit enforcement ────────────────────────────────

  // Resolve the plan limits, blocking with 402 when there's no subscription at all.
  async _requireLimits(locationId) {
    const limits = await this.subscription.planLimits(locationId);
    if (!limits) {
      const err = new Error('An active subscription is required to connect a Telegram account.');
      err.statusCode = 402;
      err.code = 'SUBSCRIPTION_REQUIRED';
      throw err;
    }
    return limits;
  }

  // Plans sell a COMBINED "Telegram Accounts" count (bots + phones together). Enforce the
  // total against connectionLimit, regardless of which type is being added.
  async _enforceConnectionLimit(locationId) {
    await this.subscription.ensureEntitled(locationId);
    const limits = await this._requireLimits(locationId);
    const limit = limits.connectionLimit;
    const [bots, phones] = await Promise.all([
      Bot.countDocuments({ locationId, isActive: true }),
      Phone.countDocuments({ locationId, isActive: true }),
    ]);
    const used = bots + phones;
    if (used >= limit) {
      const err = new Error(
        `Your ${limits.planName || 'current'} plan includes ${limit} Telegram account${limit === 1 ? '' : 's'}. Upgrade to connect more.`,
      );
      err.statusCode = 402;
      err.code = 'CONNECTION_LIMIT';
      throw err;
    }
    return limits;
  }

  async _enforceBotLimit(locationId) {
    return this._enforceConnectionLimit(locationId);
  }

  async _enforcePhoneLimit(locationId) {
    return this._enforceConnectionLimit(locationId);
  }

  // ── Bots ─────────────────────────────────────────────

  async connectBot(locationId, botToken, label = '') {
    // Step 0: entitlement + plan bot limit (throws 402 BOT_LIMIT / SUBSCRIPTION_REQUIRED).
    await this._enforceBotLimit(locationId);

    // Step 1: Validate the bot token with Telegram.
    const botInfo = await this.telegram.validateBotToken(botToken);

    // Step 2: Guard against connecting the same bot twice to this location.
    const duplicate = await Bot.findOne({ locationId, botId: String(botInfo.id) }).lean();
    if (duplicate) {
      const err = new Error('This bot is already connected to this sub-account.');
      err.statusCode = 409;
      err.code = 'BOT_ALREADY_CONNECTED';
      throw err;
    }

    // Step 3: Make sure a skeleton Installation exists (lazy token mint on first use).
    await this._ensureInstallation(locationId);

    // Step 4: Generate a per-bot webhook secret and create the Bot doc. The _id is used
    // in the webhook path, so create the doc first, then set the webhook with that _id.
    const webhookSecret = this.crypto.generateWebhookSecret();
    const encryptedToken = this.crypto.encrypt(botToken);

    const bot = await Bot.create({
      locationId,
      botToken: encryptedToken,
      botUsername: botInfo.username,
      botId: String(botInfo.id),
      webhookSecret,
      label,
      isActive: true,
      lastActivityAt: new Date(),
    });

    // Step 5: Register the webhook with Telegram (path carries locationId + botId).
    try {
      await this.telegram.setWebhook(botToken, locationId, String(bot._id), webhookSecret);
    } catch (err) {
      // Roll back the doc so a failed webhook doesn't leave a dead bot counting against the limit.
      await Bot.deleteOne({ _id: bot._id });
      throw err;
    }

    console.log(`Bot @${botInfo.username} connected for location ${locationId} (connection ${bot._id})`);

    // Step 6: Ensure Telegram custom fields exist so contact data persists (best-effort).
    if (this.ghlService) {
      this.ghlService.ensureTelegramCustomFields(locationId).catch(() => {});
    }

    return {
      connected: true,
      bot: {
        id: String(bot._id),
        username: botInfo.username,
        botId: String(botInfo.id),
        isActive: true,
      },
    };
  }

  async disconnectBot(locationId, botId) {
    const bot = await Bot.findOne({ _id: botId, locationId });
    if (!bot) {
      const err = new Error('Bot connection not found for this location.');
      err.statusCode = 404;
      throw err;
    }

    try {
      const botToken = this.crypto.decrypt(bot.botToken);
      await this.telegram.deleteWebhook(botToken);
    } catch (err) {
      console.warn(`[Connections] Failed to delete webhook for bot ${botId} (continuing): ${err.message}`);
    }

    await Bot.deleteOne({ _id: bot._id });
    console.log(`Bot disconnected for location ${locationId} (connection ${botId})`);

    return { connected: false, botId: String(botId) };
  }

  // ── Phones ───────────────────────────────────────────

  // Enforce the phone limit before starting the auth flow (send-code). Throws 402.
  async ensurePhoneSlotAvailable(locationId) {
    await this._enforcePhoneLimit(locationId);
  }

  async disconnectPhone(locationId, phoneId) {
    const phone = await Phone.findOne({ _id: phoneId, locationId });
    if (!phone) {
      const err = new Error('Phone connection not found for this location.');
      err.statusCode = 404;
      throw err;
    }

    // Destroy the GramJS client (keyed by connectionId = phone._id).
    try {
      await this.connectionManager.disconnect(String(phone._id));
    } catch (err) {
      console.warn(`[Connections] Failed to disconnect phone client ${phoneId} (continuing): ${err.message}`);
    }

    await Phone.deleteOne({ _id: phone._id });
    // Clean up any pending auth session for this location.
    await PhoneAuthSession.deleteOne({ locationId });

    console.log(`Phone disconnected for location ${locationId} (connection ${phoneId})`);
    return { connected: false, phoneId: String(phoneId) };
  }

  // ── Transport resolution helpers (used by webhooks + workflows) ──

  // Decrypted token for a specific bot connection, or null.
  async getBotTokenById(locationId, botId) {
    const bot = await Bot.findOne({ _id: botId, locationId, isActive: true }).lean();
    if (!bot) return null;
    return this.crypto.decrypt(bot.botToken);
  }

  // Any active bot for this location (fallback when a mapping has no connection).
  async getAnyActiveBot(locationId) {
    const bot = await Bot.findOne({ locationId, isActive: true }).sort({ lastActivityAt: -1 }).lean();
    if (!bot) return null;
    return { id: String(bot._id), botToken: this.crypto.decrypt(bot.botToken), botUsername: bot.botUsername };
  }

  // Find a bot doc by its Telegram botId (used by the webhook secret check isn't — that
  // uses _id — but kept for completeness).
  async getBotByTelegramId(locationId, telegramBotId) {
    return Bot.findOne({ locationId, botId: String(telegramBotId) }).lean();
  }

  async hasAnyBot(locationId) {
    return (await Bot.countDocuments({ locationId, isActive: true })) > 0;
  }

  async hasAnyPhone(locationId) {
    return (await Phone.countDocuments({ locationId, isActive: true })) > 0;
  }

  // ── Internal ─────────────────────────────────────────

  // Ensure a skeleton Installation row exists so getAccessToken can mint lazily. Mirrors
  // v1 settings.service behaviour (try to mint a location token from the company token).
  async _ensureInstallation(locationId) {
    const existing = await Installation.findOne({ locationId });
    if (existing) return existing;

    const setOnInsert = {
      locationId,
      status: 'active',
      installedAt: new Date(),
      conversationProviderId: process.env.GHL_CONVERSATION_PROVIDER_ID || '',
    };

    const companyLocation = await CompanyLocation.findOne({ locationIds: locationId });
    if (companyLocation) {
      try {
        const locationToken = await this.authService.generateLocationToken(
          companyLocation.companyId,
          locationId,
        );
        setOnInsert.companyId = companyLocation.companyId;
        setOnInsert.accessToken = this.crypto.encrypt(locationToken.accessToken);
        setOnInsert.refreshToken = this.crypto.encrypt(locationToken.refreshToken);
        setOnInsert.tokenExpiresAt = new Date(Date.now() + locationToken.expiresIn * 1000);
        console.log(`Location token generated for ${locationId}`);
      } catch (error) {
        console.warn(`Could not generate location token for ${locationId}, will be generated lazily: ${error.message}`);
      }
    }

    return Installation.findOneAndUpdate(
      { locationId },
      { $setOnInsert: setOnInsert },
      { upsert: true, returnDocument: 'after', new: true },
    );
  }
}

module.exports = ConnectionService;
