const mongoose = require('mongoose');

/**
 * A single connected Telegram PHONE account (MTProto/GramJS). Many per location (v2
 * multi-phone). The _id is the connectionId used to key the GramJS client pool.
 */
const PhoneSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, index: true },
    phoneNumber: { type: String, required: true },
    sessionString: { type: String, required: true }, // encrypted
    telegramUserId: { type: String },
    telegramUsername: { type: String },
    displayName: { type: String },
    label: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    lastActivityAt: { type: Date },
  },
  { collection: 'phones', timestamps: true },
);

// A phone number should only be connected once per location.
PhoneSchema.index({ locationId: 1, phoneNumber: 1 }, { unique: true });

module.exports = mongoose.model('Phone', PhoneSchema);
