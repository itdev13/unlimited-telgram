const axios = require('axios');
const Installation = require('../schemas/installation.schema');
const OAuthToken = require('../schemas/oauth-token.schema');
const CompanyLocation = require('../schemas/company-location.schema');
const { formatError } = require('../utils/format-error');

/**
 * OAuth + token lifecycle. Tokens live in the `oauth_tokens` collection (location + company
 * types), separate from the `installations` install record — so status and tokens never
 * desync. Handles location/company installs, lazy company→location minting, refresh with
 * invalid_grant race handling, and the central getAccessToken accessor.
 */
class AuthService {
  constructor(cryptoService) {
    this.crypto = cryptoService;
    this.ghlApiBase = process.env.GHL_API_BASE;
    if (!this.ghlApiBase) throw new Error('GHL_API_BASE is required');
  }

  // ── OAuth callback ───────────────────────────────────────────

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
      // Store the location token.
      await OAuthToken.findOneAndUpdate(
        { locationId, tokenType: 'location' },
        {
          locationId,
          companyId: companyId || '',
          tokenType: 'location',
          accessToken: this.crypto.encrypt(access_token),
          refreshToken: this.crypto.encrypt(refresh_token),
          expiresAt,
          isActive: true,
        },
        { upsert: true, returnDocument: 'after' },
      );
      // Ensure the install record is active.
      await Installation.findOneAndUpdate(
        { locationId },
        {
          companyId: companyId || '',
          locationId,
          status: 'active',
          installedAt: new Date(),
          $unset: { uninstalledAt: '' },
          $setOnInsert: { conversationProviderId: process.env.GHL_CONVERSATION_PROVIDER_ID || '' },
        },
        { upsert: true, returnDocument: 'after' },
      );
      console.log(`OAuth tokens stored for location: ${locationId}`);
      return { locationId, companyId };
    }

    if (companyId) {
      // Store the company token.
      await OAuthToken.findOneAndUpdate(
        { companyId, tokenType: 'company' },
        {
          companyId,
          tokenType: 'company',
          accessToken: this.crypto.encrypt(access_token),
          refreshToken: this.crypto.encrypt(refresh_token),
          expiresAt,
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

        // Self-heal: reactivate any of this company's locations left 'uninstalled', since a
        // company-level (re)install carries no per-location token. Location tokens mint lazily.
        if (locationIds.length) {
          const reactivated = await Installation.updateMany(
            { locationId: { $in: locationIds }, status: 'uninstalled' },
            { $set: { status: 'active', companyId }, $unset: { uninstalledAt: '' } },
          );
          if (reactivated.modifiedCount) {
            console.log(`Reactivated ${reactivated.modifiedCount} previously-uninstalled location(s) for company ${companyId}`);
          }
        }
      } catch (error) {
        console.error(`Failed to fetch company locations for ${companyId} | ${formatError(error)}`);
      }
      return { companyId };
    }

    throw new Error('OAuth response missing both locationId and companyId');
  }

  async wasRecentlyInstalled(windowMs = 5 * 60 * 1000) {
    const since = new Date(Date.now() - windowMs);
    const tok = await OAuthToken.findOne({
      isActive: true,
      createdAt: { $gte: since },
    }).select('_id').lean();
    return !!tok;
  }

  // ── Company locations ────────────────────────────────────────

  async _getCompanyLocations(accessToken, companyId) {
    const res = await axios.get(`${this.ghlApiBase}/locations/search`, {
      params: { companyId },
      headers: { Authorization: `Bearer ${accessToken}`, Version: process.env.GHL_API_VERSION },
    });
    return res.data.locations || [];
  }

  // ── Company → location token minting ─────────────────────────

  async generateLocationToken(companyId, locationId) {
    const companyToken = await OAuthToken.findActiveCompanyToken(companyId);
    if (!companyToken) {
      const err = new Error(`No active company token for company: ${companyId}`);
      err.statusCode = 401;
      throw err;
    }

    let accessToken = this.crypto.decrypt(companyToken.accessToken);
    if (companyToken.needsRefresh()) {
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
    const companyToken = await OAuthToken.findOne({ companyId, tokenType: 'company' });
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
        await OAuthToken.updateOne({ companyId, tokenType: 'company' }, { isActive: false });
        console.error(`[Auth] Company ${companyId} refresh token revoked — deactivated company token`);
      }
      throw error;
    }

    const { access_token, refresh_token: newRefreshToken, expires_in } = tokenResponse.data;
    await OAuthToken.updateOne(
      { companyId, tokenType: 'company' },
      {
        accessToken: this.crypto.encrypt(access_token),
        refreshToken: this.crypto.encrypt(newRefreshToken),
        expiresAt: new Date(Date.now() + expires_in * 1000),
        isActive: true,
      },
    );
    return access_token;
  }

  // ── Location token refresh ───────────────────────────────────

  async refreshAccessToken(locationId) {
    const token = await OAuthToken.findActiveToken(locationId);
    if (!token) {
      const err = new Error(`No token found for location: ${locationId}`);
      err.statusCode = 401;
      throw err;
    }
    const refreshToken = this.crypto.decrypt(token.refreshToken);

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
      await OAuthToken.updateOne(
        { locationId, tokenType: 'location' },
        {
          accessToken: this.crypto.encrypt(access_token),
          refreshToken: this.crypto.encrypt(newRefreshToken),
          expiresAt: new Date(Date.now() + expires_in * 1000),
        },
      );
      return access_token;
    } catch (error) {
      if (error?.response?.data?.error === 'invalid_grant') {
        console.warn(`invalid_grant for ${locationId}, checking if refreshed by another process`);
        const fresh = await OAuthToken.findActiveToken(locationId);
        if (fresh && fresh.accessToken !== token.accessToken) {
          return this.crypto.decrypt(fresh.accessToken);
        }
      }
      throw error;
    }
  }

  // ── Central accessor ─────────────────────────────────────────

  async getAccessToken(locationId) {
    // 1) Location token if present.
    const token = await OAuthToken.findActiveToken(locationId);
    if (token) {
      if (token.needsRefresh()) return this.refreshAccessToken(locationId);
      return this.crypto.decrypt(token.accessToken);
    }

    // 2) Mint a location token from the company token.
    const companyLocation = await CompanyLocation.findOne({ locationIds: locationId });
    if (companyLocation) {
      console.log(`No valid token for ${locationId}, generating from company ${companyLocation.companyId}`);
      const minted = await this.generateLocationToken(companyLocation.companyId, locationId);
      await OAuthToken.findOneAndUpdate(
        { locationId, tokenType: 'location' },
        {
          locationId,
          companyId: companyLocation.companyId,
          tokenType: 'location',
          accessToken: this.crypto.encrypt(minted.accessToken),
          refreshToken: this.crypto.encrypt(minted.refreshToken),
          expiresAt: new Date(Date.now() + minted.expiresIn * 1000),
          isActive: true,
        },
        { upsert: true, returnDocument: 'after' },
      );
      // Make sure the install record exists/active too.
      await Installation.findOneAndUpdate(
        { locationId },
        {
          companyId: companyLocation.companyId,
          locationId,
          status: 'active',
          $unset: { uninstalledAt: '' },
          $setOnInsert: { installedAt: new Date(), conversationProviderId: process.env.GHL_CONVERSATION_PROVIDER_ID || '' },
        },
        { upsert: true, returnDocument: 'after' },
      );
      return minted.accessToken;
    }

    const err = new Error(`No installation for location: ${locationId}`);
    err.statusCode = 401;
    throw err;
  }

  // ── SSO ──────────────────────────────────────────────────────

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
