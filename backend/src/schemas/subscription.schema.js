const mongoose = require('mongoose');

/**
 * One subscription per location. Mirrors GHL marketplace plan entitlement (GHL collects
 * the monthly fee). Based on HelmDesk's model, with botLimit/phoneLimit for v2 tiers.
 *
 * status:
 *   trialing  — in the 3-day free trial (entitled)
 *   active    — paying (entitled)
 *   past_due  — payment failed, blocked (not entitled)
 *   canceled  — uninstalled / cancelled (not entitled)
 *   inactive  — default / unknown (not entitled)
 */
const SubscriptionSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, unique: true, index: true },
    companyId: { type: String, index: true },
    appId: { type: String },

    planId: { type: String },
    planName: { type: String },
    priceUsd: { type: Number },
    // Combined bots + phones ("Telegram Accounts") the plan allows.
    connectionLimit: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ['active', 'trialing', 'past_due', 'canceled', 'inactive'],
      default: 'inactive',
      index: true,
    },
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },
    trialEndsAt: { type: Date },
    canceledAt: { type: Date },
    rawWebhookData: { type: mongoose.Schema.Types.Mixed },
  },
  { collection: 'subscriptions', timestamps: true },
);

SubscriptionSchema.methods.isEntitled = function isEntitled() {
  return this.status === 'active' || this.status === 'trialing';
};

module.exports = mongoose.model('Subscription', SubscriptionSchema);
