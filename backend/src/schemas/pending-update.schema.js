const mongoose = require('mongoose');

const PendingUpdateSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, index: true },
    rawUpdate: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'completed', 'failed', 'skipped'],
      default: 'pending',
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    lastAttemptAt: { type: Date },
    errorMessage: { type: String },
    processedAt: { type: Date },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
      index: { expires: 0 },
    },
  },
  { collection: 'pending_updates', timestamps: { createdAt: true, updatedAt: false } },
);

PendingUpdateSchema.index({ status: 1, attempts: 1 });

module.exports = mongoose.model('PendingUpdate', PendingUpdateSchema);
