const mongoose = require('mongoose');

const ContactMappingSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, index: true },
    telegramChatId: { type: Number, required: true },
    // The sender's actual Telegram user ID. Distinct from telegramChatId, which for a
    // GROUP is the group's id — so this is what group-member actions (Remove from Group)
    // must use to target the person. For a 1:1 DM it equals telegramChatId.
    telegramUserId: { type: Number },
    ghlContactId: { type: String, required: true },
    telegramUsername: { type: String },
    telegramFirstName: { type: String, required: true },
    source: { type: String, enum: ['bot', 'phone'], default: 'bot' },
    // The connection (bot._id or phone._id) that first created this mapping.
    connectionId: { type: String, default: '' },
    // The connection (bot._id or phone._id) the MOST RECENT inbound came through. v2
    // multi-connection: outbound replies are routed back out through this connection so
    // the conversation stays on the same bot/phone the contact last reached us on.
    lastConnectionId: { type: String, default: '' },
    // Last time we refreshed the Telegram custom fields on the GHL contact (username,
    // last_message_at). Throttles GHL writes to ~once/day instead of per message.
    ghlFieldsSyncedAt: { type: Date },
    // True once the full Telegram field set has been written to the GHL contact. Lets an
    // existing contact (created before the fields existed) get a one-time backfill of all
    // empty Telegram fields on its next message.
    ghlFieldsBackfilled: { type: Boolean },
  },
  { collection: 'contact_mappings', timestamps: { createdAt: true, updatedAt: false } },
);

ContactMappingSchema.index({ locationId: 1, telegramChatId: 1 }, { unique: true });
ContactMappingSchema.index({ locationId: 1, ghlContactId: 1 });

module.exports = mongoose.model('ContactMapping', ContactMappingSchema);
