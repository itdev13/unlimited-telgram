const mongoose = require('mongoose');

const PhoneAuthSessionSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, unique: true, index: true },
    phoneNumber: { type: String, required: true },
    phoneCodeHash: { type: String, required: true },
    tempSessionString: { type: String, required: true },
    step: { type: String, required: true, enum: ['code_sent', 'awaiting_2fa'] },
    // Set when this auth flow is intended to transfer the phone from another location.
    // On _completeAuth we'll disconnect that location's client and clear its phoneConfig.
    transferFromLocationId: { type: String, default: null },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 10 * 60 * 1000),
      index: { expires: 0 },
    },
  },
  { collection: 'phone_auth_sessions', timestamps: { createdAt: true, updatedAt: false } },
);

module.exports = mongoose.model('PhoneAuthSession', PhoneAuthSessionSchema);
