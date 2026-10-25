const mongoose = require('mongoose');

const CompanyLocationSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, unique: true, index: true },
    locationIds: { type: [String], default: [] },
  },
  { collection: 'company_locations', timestamps: true },
);

module.exports = mongoose.model('CompanyLocation', CompanyLocationSchema);
