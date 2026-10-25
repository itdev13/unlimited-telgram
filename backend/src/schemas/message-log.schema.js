const mongoose = require('mongoose');

const MessageDirection = {
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
};

const MessageStatus = {
  SENT: 'sent',
  DELIVERED: 'delivered',
  FAILED: 'failed',
};

const MessageLogSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, index: true },
    direction: { type: String, required: true, enum: Object.values(MessageDirection) },
    telegramChatId: { type: Number, required: true },
    ghlMessageId: { type: String },
    telegramMessageId: { type: Number },
    status: { type: String, required: true, enum: Object.values(MessageStatus) },
    errorMessage: { type: String },
    // 'manual' marks an outbound message a human agent typed in the native Telegram app
    // (vs. our own programmatic sends). Used to dedup and for reporting.
    source: { type: String },
  },
  { collection: 'message_logs', timestamps: { createdAt: true, updatedAt: false } },
);

MessageLogSchema.index({ locationId: 1, createdAt: -1 });
MessageLogSchema.index({ locationId: 1, telegramMessageId: 1, direction: 1 });

const MessageLog = mongoose.model('MessageLog', MessageLogSchema);

module.exports = { MessageLog, MessageDirection, MessageStatus };
