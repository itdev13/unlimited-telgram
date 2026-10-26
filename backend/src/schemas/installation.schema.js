const mongoose = require('mongoose');

/**
 * One document per GHL location. Holds location-level state only: OAuth tokens and the
 * conversation provider. Connections (bots/phones) live in their own collections, and
 * subscription/trial state lives in the Subscription collection — NO wallet/metered
 * billing fields (v2 is subscription-based).
 */
const InstallationSchema = new mongoose.Schema(
  {
    companyId: { type: String, index: true },
    locationId: { type: String, required: true, unique: true, index: true },

    // Tokens live in the oauth_tokens collection (not here) so status/token lifecycles
    // can't desync.
    status: { type: String, enum: ['active', 'uninstalled'], default: 'active', index: true },
    conversationProviderId: { type: String, default: '' },

    // GHL marketplace metadata captured at install (for upgrade deep-links etc.).
    appId: { type: String },
    versionId: { type: String },
    whitelabelDomain: { type: String },

    installedAt: { type: Date, default: Date.now },
    uninstalledAt: { type: Date },
  },
  { collection: 'installations', timestamps: true },
);

module.exports = mongoose.model('Installation', InstallationSchema);
