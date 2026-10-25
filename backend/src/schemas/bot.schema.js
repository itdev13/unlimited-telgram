const mongoose = require('mongoose');

/**
 * A single connected Telegram BOT. Many per location (v2 multi-bot). Each bot has its own
 * webhook secret, validated against the x-telegram-bot-api-secret-token header. The bot's
 * _id is used in the per-bot webhook path (/webhooks/telegram/:locationId/:botId).
 */
const BotSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, index: true },
    botToken: { type: String, required: true }, // encrypted
    botUsername: { type: String },
    botId: { type: String },
    webhookSecret: { type: String, required: true },
    label: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    lastActivityAt: { type: Date },
  },
  { collection: 'bots', timestamps: true },
);

// A given bot (by Telegram botId) should only be connected once per location.
BotSchema.index({ locationId: 1, botId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Bot', BotSchema);
