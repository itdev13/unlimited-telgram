const axios = require('axios');
const Installation = require('../schemas/installation.schema');
const CompanyToken = require('../schemas/company-token.schema');
const CompanyLocation = require('../schemas/company-location.schema');
const { formatError } = require('../utils/format-error');

/**
 * OAuth + token lifecycle. Ported from v1, minus referral tracking (not in v2 scope).
 * Handles location-level and company-level installs, company→location token minting,
 * refresh with invalid_grant race handling, and the central getAccessToken accessor.
 */
class AuthService {
  constructor(cryptoService) {
    this.crypto = cryptoService;
    this.ghlApiBase = process.env.GHL_API_BASE;
    if (!this.ghlApiBase) throw new Error('GHL_API_BASE is required');
  }

  async handleOAuthCallback(code, state) {
    let tokenResponse;
    try {
      tokenResponse = await axios.post(
        `${this.ghlApiBase}/oauth/token`,
        new URLSearchParams({
          client_id: process.env.GHL_CLIENT_ID,
          client_secret: process.env.GHL_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: process.env.GHL_REDIRECT_URI,
        }),
      );
    } catch (error) {
      console.error(`Token exchange failed: status=${error?.response?.status}, data=${JSON.stringify(error?.response?.data)}`);
      throw error;
    }

    const { access_token, refresh_token, expires_in, locationId, companyId } = tokenResponse.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    if (locationId) {
      await Installation.findOneAndUpdate(
        { locationId },
        {
          companyId: companyId || '',
          locationId,
          accessToken: this.crypto.encrypt(access_token),
          refreshToken: this.crypto.encrypt(refresh_token),
          tokenExpiresAt: expiresAt,
          status: 'active',
          installedAt: new Date(),
          $setOnInsert: { conversationProviderId: process.env.GHL_CONVERSATION_PROVIDER_ID || '' },
        },
        { upsert: true, returnDocument: 'after' },
      );
      console.log(`OAuth tokens stored for location: ${locationId}`);
      return { locationId, companyId };
    }

    if (companyId) {
      await CompanyToken.findOneAndUpdate(
        { companyId },
        {
          companyId,
          accessToken: this.crypto.encrypt(access_token),
          refreshToken: this.crypto.encrypt(refresh_token),
          tokenExpiresAt: expiresAt,
          isActive: true,
        },
        { upsert: true, returnDocument: 'after' },
      );
      console.log(`Company-level OAuth tokens stored for company: ${companyId}`);

      try {
        const locations = await this._getCompanyLocations(access_token, companyId);
        const locationIds = locations.map((loc) => loc.id);
        await CompanyLocation.findOneAndUpdate(
          { companyId },
          { companyId, locationIds },
          { upsert: true, returnDocument: 'after' },
        );
        console.log(`Stored ${locationIds.length} locations for company: ${companyId}`);
      } catch (error) {
        console.error(`Failed to fetch company locations for ${companyId} | ${formatError(error)}`);
      }
      return { companyId };
    }

    throw new Error('OAuth response missing both locationId and companyId');
  }

  async wasRecentlyInstalled(windowMs = 5 * 60 * 1000) {
    const since = new Date(Date.now() - windowMs);
    const inst = await Installation.findOne({
      status: 'active',
      accessToken: { $exists: true, $nin: [null, ''] },
      refreshToken: { $exists: true, $nin: [null, ''] },
      installedAt: { $gte: since },
    })
      .sort({ installedAt: -1 })
      .select('_id')
      .lean();
    return !!inst;
  }

  async _getCompanyLocations(accessToken, companyId) {
    const res = await axios.get(`${this.ghlApiBase}/locations/search`, {
      params: { companyId },
      headers: { Authorization: `Bearer ${accessToken}`, Version: process.env.GHL_API_VERSION },
    });
    return res.data.locations || [];
  }

  async generateLocationToken(companyId, locationId) {
    const companyToken = await CompanyToken.findOne({ companyId, isActive: true });
    if (!companyToken) {
      const err = new Error(`No active company token for company: ${companyId}`);
      err.statusCode = 401;
      throw err;
    }

    let accessToken = this.crypto.decrypt(companyToken.accessToken);
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
    if (companyToken.tokenExpiresAt < fiveMinutesFromNow) {
      accessToken = await this._refreshCompanyToken(companyId);
    }

    const res = await axios.post(
      `${this.ghlApiBase}/oauth/locationToken`,
      { companyId, locationId },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: process.env.GHL_API_VERSION,
          'Content-Type': 'application/json',
        },
      },
    );
    console.log(`Location token generated for ${locationId} from company ${companyId}`);
    return {
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token,
      expiresIn: res.data.expires_in,
    };
  }

  async _refreshCompanyToken(companyId) {
    const companyToken = await CompanyToken.findOne({ companyId });
    if (!companyToken) {
      const err = new Error(`No company token for: ${companyId}`);
      err.statusCode = 401;
      throw err;
    }
    const refreshToken = this.crypto.decrypt(companyToken.refreshToken);

    let tokenResponse;
    try {
      tokenResponse = await axios.post(
        `${this.ghlApiBase}/oauth/token`,
        new URLSearchParams({
          client_id: process.env.GHL_CLIENT_ID,
          client_secret: process.env.GHL_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      );
    } catch (error) {
      if (error?.response?.data?.error === 'invalid_grant') {
        await CompanyToken.updateOne({ companyId }, { isActive: false });
        console.error(`[Auth] Company ${companyId} refresh token revoked — deactivated CompanyToken`);
      }
      throw error;
    }

    const { access_token, refresh_token: newRefreshToken, expires_in } = tokenResponse.data;
    await CompanyToken.updateOne(
      { companyId },
      {
        accessToken: this.crypto.encrypt(access_token),
        refreshToken: this.crypto.encrypt(newRefreshToken),
        tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
      },
    );
    return access_token;
  }

  async refreshAccessToken(locationId) {
    const installation = await Installation.findOne({ locationId });
    if (!installation) {
      const err = new Error(`No installation found for location: ${locationId}`);
      err.statusCode = 401;
      throw err;
    }
    const refreshToken = this.crypto.decrypt(installation.refreshToken);

    try {
      const tokenResponse = await axios.post(
        `${this.ghlApiBase}/oauth/token`,
        new URLSearchParams({
          client_id: process.env.GHL_CLIENT_ID,
          client_secret: process.env.GHL_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      );
      const { access_token, refresh_token: newRefreshToken, expires_in } = tokenResponse.data;
      await Installation.updateOne(
        { locationId },
        {
          accessToken: this.crypto.encrypt(access_token),
          refreshToken: this.crypto.encrypt(newRefreshToken),
          tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
        },
      );
      return access_token;
    } catch (error) {
      if (error?.response?.data?.error === 'invalid_grant') {
        console.warn(`invalid_grant for ${locationId}, checking if refreshed by another process`);
        const fresh = await Installation.findOne({ locationId });
        if (fresh && fresh.accessToken !== installation.accessToken) {
          return this.crypto.decrypt(fresh.accessToken);
        }
      }
      throw error;
    }
  }

  async getAccessToken(locationId) {
    const installation = await Installation.findOne({
      locationId,
      $or: [{ status: 'active' }, { status: { $exists: false } }],
    });

    if (installation && installation.accessToken) {
      const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
      if (installation.tokenExpiresAt && installation.tokenExpiresAt < fiveMinutesFromNow) {
        return this.refreshAccessToken(locationId);
      }
      return this.crypto.decrypt(installation.accessToken);
    }

    const companyLocation = await CompanyLocation.findOne({ locationIds: locationId });
    if (companyLocation) {
      console.log(`No valid token for ${locationId}, generating from company ${companyLocation.companyId}`);
      const locationToken = await this.generateLocationToken(companyLocation.companyId, locationId);
      await Installation.findOneAndUpdate(
        { locationId },
        {
          companyId: companyLocation.companyId,
          locationId,
          accessToken: this.crypto.encrypt(locationToken.accessToken),
          refreshToken: this.crypto.encrypt(locationToken.refreshToken),
          tokenExpiresAt: new Date(Date.now() + locationToken.expiresIn * 1000),
          status: 'active',
          installedAt: new Date(),
          $setOnInsert: { conversationProviderId: process.env.GHL_CONVERSATION_PROVIDER_ID || '' },
        },
        { upsert: true, returnDocument: 'after' },
      );
      return locationToken.accessToken;
    }

    const err = new Error(`No installation for location: ${locationId}`);
    err.statusCode = 401;
    throw err;
  }

  decryptSsoPayload(encryptedPayload) {
    try {
      return this.crypto.decryptSsoPayload(encryptedPayload);
    } catch (error) {
      console.error(`SSO decryption failed | ${formatError(error)}`);
      const err = new Error('Invalid or expired SSO session');
      err.statusCode = 401;
      throw err;
    }
  }
}

module.exports = AuthService;
