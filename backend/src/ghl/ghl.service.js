const axios = require('axios');

class GhlService {
  constructor(authService) {
    this.authService = authService;
    this.apiBase = process.env.GHL_API_BASE;
    this.apiVersion = process.env.GHL_API_VERSION;
    if (!this.apiBase) throw new Error('GHL_API_BASE is required');
    if (!this.apiVersion) throw new Error('GHL_API_VERSION is required');
    // Per-location cache of { telegram_key: customFieldId }, so contact create/update can
    // set values by field ID. Populated on connect (ensureTelegramCustomFields) and lazily.
    this._tgFieldIds = new Map();
  }

  /**
   * Get the { key: fieldId } map for a location's Telegram custom fields, ensuring the
   * folder + fields exist. Cached in-memory so it's one call per location per process.
   */
  async getTelegramFieldIds(locationId) {
    if (this._tgFieldIds.has(locationId)) return this._tgFieldIds.get(locationId);
    const idMap = await this.ensureTelegramCustomFields(locationId);
    this._tgFieldIds.set(locationId, idMap);
    return idMap;
  }

  // ── API Request Wrapper (401 retry + 429 backoff) ───────────

  async _apiRequest(locationId, requestFn) {
    let token = await this.authService.getAccessToken(locationId);
    let lastError;

    // Try with current token, retry once on 401
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this._executeWithBackoff(() => requestFn(token));
      } catch (error) {
        lastError = error;
        if (attempt === 0 && error?.response?.status === 401) {
          console.warn(
            `401 for ${locationId}, refreshing token and retrying` +
              ` | Response: ${JSON.stringify(error?.response?.data)}`,
          );
          token = await this.authService.getAccessToken(locationId);
          continue;
        }
        console.error(
          `GHL API error for ${locationId}` +
            ` | Status: ${error?.response?.status}` +
            ` | Response: ${JSON.stringify(error?.response?.data)}`,
        );
        throw error;
      }
    }

    throw lastError;
  }

  async _executeWithBackoff(fn, maxRetries = 3) {
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (error?.response?.status === 429 && attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000;
          console.warn(`429 rate limited, backing off ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }

  // ── Contacts ───────────────────────────────────────────────

  async createContact(locationId, firstName, lastName, extraFields) {
    const res = await this._apiRequest(locationId, (token) =>
      axios.post(
        `${this.apiBase}/contacts/`,
        {
          locationId,
          firstName,
          lastName: lastName || '',
          source: 'Telegram Messaging Connector',
          ...extraFields,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Version: this.apiVersion,
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    console.log(`Created GHL contact: ${res.data.contact.id}`);
    return res.data.contact;
  }

  /**
   * Update an existing GHL contact. `fields` may include customFields (array of
   * { key, field_value }) and standard fields. Best-effort caller responsibility —
   * this throws on API error like other methods.
   */
  async updateContact(locationId, contactId, fields) {
    const res = await this._apiRequest(locationId, (token) =>
      axios.put(`${this.apiBase}/contacts/${contactId}`, fields, {
        headers: {
          Authorization: `Bearer ${token}`,
          Version: this.apiVersion,
          'Content-Type': 'application/json',
        },
      }),
    );
    return res.data.contact;
  }

  // ── Custom Field Definitions ───────────────────────────────

  // List a location's contact custom fields AND folders (so we create only what's missing).
  async listCustomFields(locationId) {
    const res = await this._apiRequest(locationId, (token) =>
      axios.get(`${this.apiBase}/locations/${locationId}/customFields`, {
        params: { model: 'contact' },
        headers: { Authorization: `Bearer ${token}`, Version: this.apiVersion },
      }),
    );
    return {
      fields: res.data.customFields || [],
      folders: res.data.folders || res.data.customFieldFolders || [],
    };
  }

  async createCustomFieldFolder(locationId, name) {
    const res = await this._apiRequest(locationId, (token) =>
      axios.post(
        `${this.apiBase}/locations/${locationId}/customFields`,
        { name, model: 'contact', documentType: 'folder', dataType: 'TEXT' },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Version: this.apiVersion,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      ),
    );
    // Response key varies by version: customFieldFolder / customField / top-level id.
    return res.data.customFieldFolder?.id || res.data.customField?.id || res.data.id;
  }

  async createCustomField(locationId, { name, dataType = 'TEXT', parentId }) {
    const res = await this._apiRequest(locationId, (token) =>
      axios.post(
        `${this.apiBase}/locations/${locationId}/customFields`,
        {
          name,
          dataType,
          model: 'contact',
          documentType: 'field',
          ...(parentId ? { parentId } : {}),
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Version: this.apiVersion,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      ),
    );
    return res.data.customField;
  }

  /**
   * Ensure the "Telegram Message Connector" folder and the 7 Telegram custom fields exist
   * on this location, so values we send on the contact actually persist (GHL silently
   * drops values for undefined fields). Idempotent and best-effort — never throws.
   *
   * Returns a { <key>: <fieldId> } map so contact create/update can set values by field
   * ID (more reliable than key). GHL derives the key from the name as contact.<snake>.
   */
  async ensureTelegramCustomFields(locationId) {
    const FOLDER_NAME = 'Telegram Message Connector';
    const WANT = [
      { key: 'telegram_username', name: 'Telegram Username' },
      { key: 'telegram_chat_id', name: 'Telegram Chat ID' },
      { key: 'telegram_user_id', name: 'Telegram User ID' },
      { key: 'telegram_connection', name: 'Telegram Connection' },
      { key: 'telegram_bot', name: 'Telegram Bot' },
      { key: 'telegram_first_seen', name: 'Telegram First Seen' },
      { key: 'telegram_last_message_at', name: 'Telegram Last Message At' },
    ];
    const idMap = {};
    try {
      const { fields, folders } = await this.listCustomFields(locationId);

      // Map existing fields by their key (strip the contact. prefix) → id.
      const byKey = {};
      for (const f of fields) {
        const k = (f.fieldKey || '').replace(/^contact\./, '');
        if (k) byKey[k] = f.id;
      }

      // Folder: reuse if present, else create.
      let folderId = folders.find((f) => (f.name || '').trim().toLowerCase() === FOLDER_NAME.toLowerCase())?.id;
      if (!folderId) {
        try {
          folderId = await this.createCustomFieldFolder(locationId, FOLDER_NAME);
          console.log(`[GHL] Created custom field folder "${FOLDER_NAME}" for ${locationId}`);
        } catch (err) {
          console.warn(`[GHL] Could not create folder for ${locationId} (fields will be ungrouped): ${err.response?.data?.message || err.message}`);
        }
      }

      for (const f of WANT) {
        if (byKey[f.key]) { idMap[f.key] = byKey[f.key]; continue; }
        try {
          const created = await this.createCustomField(locationId, { name: f.name, parentId: folderId });
          if (created?.id) idMap[f.key] = created.id;
          console.log(`[GHL] Created custom field "${f.name}" for ${locationId}`);
        } catch (err) {
          console.warn(`[GHL] Could not create custom field "${f.name}" for ${locationId}: ${err.response?.data?.message || err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[GHL] ensureTelegramCustomFields skipped for ${locationId}: ${err.response?.data?.message || err.message}`);
    }
    // Cache for later contact create/update (set values by field ID).
    if (Object.keys(idMap).length) this._tgFieldIds.set(locationId, idMap);
    return idMap;
  }

  // Fetch a single contact (to check which fields are already set). Returns null on error.
  async getContact(locationId, contactId) {
    try {
      const res = await this._apiRequest(locationId, (token) =>
        axios.get(`${this.apiBase}/contacts/${contactId}`, {
          headers: { Authorization: `Bearer ${token}`, Version: this.apiVersion },
        }),
      );
      return res.data.contact || null;
    } catch (err) {
      console.warn(`[GHL] getContact failed for ${contactId} in ${locationId}: ${err.message}`);
      return null;
    }
  }

  async searchContactByCustomField(locationId, fieldKey, value) {
    try {
      const res = await this._apiRequest(locationId, (token) =>
        axios.get(`${this.apiBase}/contacts/search`, {
          params: { locationId, query: value },
          headers: {
            Authorization: `Bearer ${token}`,
            Version: this.apiVersion,
          },
        }),
      );

      const contacts = res.data.contacts || [];
      return contacts.length > 0 ? contacts[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * Find an existing contact by phone number (E.164). Used to merge a Telegram user who
   * shared their number into the contact that already exists in GHL (from a form, call,
   * etc.) instead of creating a duplicate. Returns the contact or null. Never throws.
   */
  async findContactByPhone(locationId, phone) {
    if (!phone) return null;
    try {
      const res = await this._apiRequest(locationId, (token) =>
        axios.post(
          `${this.apiBase}/contacts/search`,
          {
            locationId,
            pageLimit: 5,
            filters: [{ field: 'phone', operator: 'eq', value: phone }],
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Version: this.apiVersion,
              'Content-Type': 'application/json',
            },
          },
        ),
      );
      const contacts = res.data.contacts || [];
      return contacts.length > 0 ? contacts[0] : null;
    } catch (err) {
      // Fall back to the simple query search if the filtered search endpoint isn't available.
      try {
        const res = await this._apiRequest(locationId, (token) =>
          axios.get(`${this.apiBase}/contacts/`, {
            params: { locationId, query: phone, limit: 5 },
            headers: { Authorization: `Bearer ${token}`, Version: this.apiVersion },
          }),
        );
        const contacts = res.data.contacts || [];
        // Only accept an exact phone match (query search is fuzzy).
        const norm = (p) => String(p || '').replace(/[^\d]/g, '');
        return contacts.find((c) => norm(c.phone) === norm(phone)) || null;
      } catch {
        console.warn(`[GHL] findContactByPhone failed for ${locationId}: ${err.message}`);
        return null;
      }
    }
  }

  /**
   * Find an existing contact by email. Mirrors findContactByPhone. Returns the contact
   * or null. Never throws.
   */
  async findContactByEmail(locationId, email) {
    if (!email) return null;
    const target = String(email).trim().toLowerCase();
    try {
      const res = await this._apiRequest(locationId, (token) =>
        axios.post(
          `${this.apiBase}/contacts/search`,
          {
            locationId,
            pageLimit: 5,
            filters: [{ field: 'email', operator: 'eq', value: target }],
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Version: this.apiVersion,
              'Content-Type': 'application/json',
            },
          },
        ),
      );
      const contacts = res.data.contacts || [];
      return contacts.length > 0 ? contacts[0] : null;
    } catch (err) {
      try {
        const res = await this._apiRequest(locationId, (token) =>
          axios.get(`${this.apiBase}/contacts/`, {
            params: { locationId, query: target, limit: 5 },
            headers: { Authorization: `Bearer ${token}`, Version: this.apiVersion },
          }),
        );
        const contacts = res.data.contacts || [];
        return contacts.find((c) => String(c.email || '').toLowerCase() === target) || null;
      } catch {
        console.warn(`[GHL] findContactByEmail failed for ${locationId}: ${err.message}`);
        return null;
      }
    }
  }

  // ── Inbound Messages (Telegram → GHL) ──────────────────────

  async addInboundMessage(locationId, payload) {
    let res;
    try {
      res = await this._apiRequest(locationId, (token) =>
        axios.post(
          `${this.apiBase}/conversations/messages/inbound`,
          {
            type: 'Custom',
            ...payload,
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Version: this.apiVersion,
              'Content-Type': 'application/json',
            },
          },
        ),
      );
    } catch (error) {
      // Tag the "GHL contact was deleted" case so callers can drop the stale
      // mapping, recreate the contact, and retry instead of looping forever.
      const code = error?.response?.data?.canonicalCode || '';
      const msg = error?.response?.data?.message || '';
      if (code === 'CONVERSATIONS_CONTACT_DELETED' || /contact not found\/deleted/i.test(String(msg))) {
        error.contactDeleted = true;
      }
      throw error;
    }

    console.log(
      `Inbound message added: conversationId=${res.data.conversationId}, messageId=${res.data.messageId}`,
    );

    return {
      conversationId: res.data.conversationId,
      messageId: res.data.messageId,
    };
  }

  // Add an OUTBOUND message to a GHL conversation — used to reflect a manual reply
  // an agent sent from the native Telegram app, so the CRM conversation shows it.
  // Custom Conversation Provider messages are added via the inbound endpoint with the
  // conversationProviderId; `direction: 'outbound'` marks it as sent by the business
  // (agent) rather than received from the contact. This is the shape that works for
  // custom providers — the /messages/outbound endpoint rejects type 'Custom'.
  async addOutboundMessage(locationId, payload) {
    const res = await this._apiRequest(locationId, (token) =>
      axios.post(
        `${this.apiBase}/conversations/messages/inbound`,
        { type: 'Custom', direction: 'outbound', ...payload },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Version: this.apiVersion,
            'Content-Type': 'application/json',
          },
        },
      ),
    );
    console.log(
      `Outbound message added: conversationId=${res.data.conversationId}, messageId=${res.data.messageId}`,
    );
    return {
      conversationId: res.data.conversationId,
      messageId: res.data.messageId,
    };
  }

  // ── Attachments ────────────────────────────────────────────

  // Upload a file to GHL's own storage so the conversation keeps a permanent link
  // (Telegram file links expire and bot links embed the bot token). GHL accepts
  // either conversationId or contactId; we use contactId so it works for a brand
  // new contact that has no conversation yet. Max 5 MB per file.
  async uploadAttachment(locationId, { contactId, buffer, filename, mimeType }) {
    const res = await this._apiRequest(locationId, (token) => {
      // Rebuilt per attempt — a FormData body can't be safely re-sent on retry.
      const form = new FormData();
      form.append('locationId', locationId);
      form.append('contactId', contactId);
      form.append('fileAttachment', new Blob([buffer], { type: mimeType }), filename);
      return axios.post(`${this.apiBase}/conversations/messages/upload`, form, {
        headers: {
          Authorization: `Bearer ${token}`,
          Version: this.apiVersion,
        },
      });
    });

    // Response shape: { uploadedFiles: { "<filename>": "<url>" } }
    const url = Object.values(res.data?.uploadedFiles || {})[0];
    if (!url) {
      throw new Error(`GHL upload returned no URL: ${JSON.stringify(res.data)}`);
    }
    return url;
  }

  // ── Message Status Updates ─────────────────────────────────

  async updateMessageStatus(locationId, messageId, status, error) {
    // GHL requires `error` to be an object ({ code, type, message }), not a string.
    const errorPayload =
      error == null
        ? undefined
        : typeof error === 'string'
          ? { code: 'delivery_failed', type: 'saas', message: error }
          : error;

    try {
      await this._apiRequest(locationId, (token) =>
        axios.put(
          `${this.apiBase}/conversations/messages/${messageId}/status`,
          {
            status,
            ...(errorPayload ? { error: errorPayload } : {}),
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Version: this.apiVersion,
              'Content-Type': 'application/json',
            },
          },
        ),
      );
      console.log(`Message ${messageId} status updated to: ${status}`);
    } catch (err) {
      console.error(
        `Failed to update message status: ${messageId}` +
          ` | Status: ${err?.response?.status}` +
          ` | Response: ${JSON.stringify(err?.response?.data)}`,
      );
    }
  }

  // ── Company Locations ──────────────────────────────────────

  async getCompanyLocations(accessToken, companyId) {
    const res = await axios.get(`${this.apiBase}/locations/search`, {
      params: { companyId },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Version: this.apiVersion,
      },
    });

    return res.data.locations || [];
  }
}

module.exports = GhlService;
