const mongoose = require('mongoose');

const CompanyTokenSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, unique: true, index: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String, required: true },
    tokenExpiresAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
  },
  { collection: 'company_tokens', timestamps: true },
);

module.exports = mongoose.model('CompanyToken', CompanyTokenSchema);
