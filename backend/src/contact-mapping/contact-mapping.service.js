const ContactMapping = require('../schemas/contact-mapping.schema');

class ContactMappingService {
  constructor(ghlService) {
    this.ghlService = ghlService;
  }

  async getOrCreateContact(locationId, telegramUser, chatId, source = 'bot', connectionId = '') {
    // Check existing mapping
    const existing = await ContactMapping.findOne({
      locationId,
      telegramChatId: chatId,
    });

    if (existing) {
      // Self-heal: older mappings were created before telegramUserId existed. If it's
      // missing and this message carries a real sender id, backfill it now — so no
      // separate migration is needed and it fills in as contacts message.
      if (existing.telegramUserId == null && telegramUser?.id != null) {
        const uid = Number(telegramUser.id);
        if (!Number.isNaN(uid)) {
          await ContactMapping.updateOne({ _id: existing._id }, { telegramUserId: uid });
          console.log(`Backfilled telegramUserId=${uid} for chat ${chatId} (${locationId})`);
        }
      }

      // v2 multi-connection: stamp the connection this inbound came through so outbound
      // replies route back out via the same bot/phone the contact last reached us on.
      if (connectionId && existing.lastConnectionId !== connectionId) {
        await ContactMapping.updateOne({ _id: existing._id }, { lastConnectionId: connectionId });
      }

      // Keep GHL fields fresh without an API call on EVERY message. Two cases:
      //  (a) BACKFILL — this contact was created before the Telegram fields existed (they
      //      show empty in GHL). Once per contact, fill every Telegram field that's still
      //      empty: chat_id, user_id, connection, bot, first_seen, username, last_message.
      //  (b) REFRESH — otherwise just refresh username (if changed) + last_message_at, at
      //      most once/day, so there's no per-message cost.
      // Best-effort — never blocks the message.
      const newUsername = telegramUser?.username || '';
      const usernameChanged = newUsername && newUsername !== existing.telegramUsername;
      const lastSync = existing.ghlFieldsSyncedAt ? new Date(existing.ghlFieldsSyncedAt).getTime() : 0;
      const staleBeyondADay = Date.now() - lastSync > 24 * 60 * 60 * 1000;
      const needsBackfill = !existing.ghlFieldsBackfilled;

      if (needsBackfill || usernameChanged || staleBeyondADay) {
        try {
          const idMap = await this.ghlService.getTelegramFieldIds(locationId).catch(() => ({}));
          const field = (key, field_value) => (idMap[key] ? { id: idMap[key], field_value } : { key, field_value });
          const now = new Date().toISOString();
          const customFields = [];

          if (needsBackfill) {
            // Read the GHL contact once and fill only the Telegram fields that are empty,
            // so we never clobber anything a human edited.
            const contact = await this.ghlService.getContact(locationId, existing.ghlContactId);
            const cfByKey = {};
            for (const cf of (contact?.customFields || [])) {
              // GHL returns either id or a contact.<key>; index by both so we can check emptiness.
              if (cf.id) cfByKey[cf.id] = cf.value ?? cf.fieldValue;
            }
            const isEmpty = (key) => {
              const id = idMap[key];
              const v = id ? cfByKey[id] : undefined;
              return v == null || v === '';
            };
            const want = {
              telegram_username: newUsername,
              telegram_chat_id: String(chatId),
              telegram_user_id: telegramUser?.id != null ? String(telegramUser.id) : '',
              telegram_connection: source,
              telegram_bot: connectionId || '',
              telegram_first_seen: existing.createdAt ? new Date(existing.createdAt).toISOString() : now,
              telegram_last_message_at: now,
            };
            for (const [key, val] of Object.entries(want)) {
              if (val !== '' && isEmpty(key)) customFields.push(field(key, val));
            }
          } else {
            customFields.push(field('telegram_last_message_at', now));
            if (usernameChanged) customFields.push(field('telegram_username', newUsername));
          }

          if (customFields.length) {
            await this.ghlService.updateContact(locationId, existing.ghlContactId, { customFields });
          }
          await ContactMapping.updateOne(
            { _id: existing._id },
            {
              ghlFieldsSyncedAt: new Date(),
              ...(needsBackfill ? { ghlFieldsBackfilled: true } : {}),
              ...(usernameChanged ? { telegramUsername: newUsername } : {}),
            },
          );
        } catch (err) {
          console.warn(`[ContactMapping] GHL field refresh failed for ${existing.ghlContactId} (continuing): ${err.message}`);
        }
      }

      return { ghlContactId: existing.ghlContactId, isNew: false };
    }

    // Create new GHL contact
    console.log(
      `Creating new GHL contact for Telegram user: ${telegramUser.first_name} (chat: ${chatId})`,
    );

    // Resolve the Telegram custom-field IDs (ensures the folder+fields exist; cached).
    // Setting values by field ID is more reliable than by key.
    const now = new Date().toISOString();
    const values = {
      telegram_username: telegramUser.username || '',
      telegram_chat_id: String(chatId),
      telegram_user_id: telegramUser.id != null ? String(telegramUser.id) : '',
      telegram_connection: source, // 'bot' or 'phone'
      telegram_bot: connectionId || '',
      telegram_first_seen: now,
      telegram_last_message_at: now,
    };
    let customFields = [];
    try {
      const idMap = await this.ghlService.getTelegramFieldIds(locationId);
      customFields = Object.entries(values)
        .filter(([key]) => idMap[key])
        .map(([key, field_value]) => ({ id: idMap[key], field_value }));
    } catch (err) {
      console.warn(`[ContactMapping] could not resolve custom field ids for ${locationId}: ${err.message}`);
    }
    // Fallback to key-based if ids couldn't be resolved (still uses field_value shape).
    if (customFields.length === 0) {
      customFields = Object.entries(values).map(([key, field_value]) => ({ key, field_value }));
    }

    const contact = await this.ghlService.createContact(
      locationId,
      telegramUser.first_name,
      telegramUser.last_name,
      {
        tags: ['telegram', 'telesync'],
        customFields,
      },
    );

    // Store the mapping. telegramUserId is the sender's real user ID (telegramUser.id);
    // it differs from telegramChatId in groups and is what member actions need.
    // v2: stamp both connectionId (origin) and lastConnectionId (routing) with the
    // connection this first inbound came through.
    await ContactMapping.create({
      locationId,
      telegramChatId: chatId,
      telegramUserId: telegramUser.id != null ? Number(telegramUser.id) : undefined,
      ghlContactId: contact.id,
      telegramUsername: telegramUser.username || undefined,
      telegramFirstName: telegramUser.first_name,
      source,
      connectionId,
      lastConnectionId: connectionId,
      // New contacts get the full field set at create time — no backfill needed.
      ghlFieldsBackfilled: customFields.length > 0,
      ghlFieldsSyncedAt: new Date(),
    });

    console.log(`Contact mapping created: chat ${chatId} → GHL contact ${contact.id}`);

    return { ghlContactId: contact.id, isNew: true };
  }

  /**
   * The GHL contact behind this chat was deleted. Drop the stale mapping and
   * create a fresh contact + mapping. Returns the new ghlContactId.
   */
  async recreateContact(locationId, telegramUser, chatId, source = 'bot', connectionId = '') {
    await ContactMapping.deleteOne({ locationId, telegramChatId: chatId });
    console.warn(`Stale mapping removed (contact deleted) for chat ${chatId} in ${locationId} — recreating`);
    return this.getOrCreateContact(locationId, telegramUser, chatId, source, connectionId);
  }

  /**
   * A Telegram user shared their phone number. If a DIFFERENT existing GHL contact
   * already has that number (from a form, call, etc.), re-point this Telegram chat's
   * mapping to that contact so the conversation merges into the existing record instead
   * of living on a duplicate. Returns the contactId to use going forward (the matched
   * existing one, or the current one if no match). Best-effort — never throws.
   *
   * Note: this does not delete the auto-created contact; it just stops routing new
   * Telegram messages to it. (Deleting/merging contacts in GHL is a heavier operation
   * better left to the user, to avoid destroying data.)
   */
  async linkSharedPhoneToExistingContact(locationId, chatId, currentContactId, phone) {
    if (!phone || !this.ghlService.findContactByPhone) return currentContactId;
    try {
      const existing = await this.ghlService.findContactByPhone(locationId, phone);
      if (!existing || existing.id === currentContactId) return currentContactId;

      await ContactMapping.updateOne(
        { locationId, telegramChatId: chatId },
        { ghlContactId: existing.id },
      );
      console.log(
        `[ContactMapping] Linked chat ${chatId} to existing GHL contact ${existing.id} by shared phone ${phone} (was ${currentContactId}) in ${locationId}`,
      );
      return existing.id;
    } catch (err) {
      console.warn(`[ContactMapping] phone-link failed for chat ${chatId} in ${locationId} (continuing): ${err.message}`);
      return currentContactId;
    }
  }

  /**
   * A contact typed a phone/email into the chat. Fill those onto the GHL contact, but
   * ONLY the fields that are currently empty — never overwrite a value a human set.
   *
   * If the location disallows duplicate contacts and the typed phone already belongs to
   * ANOTHER contact, GHL rejects the update. In that case we re-point this Telegram chat
   * to that existing contact (merge, like the shared-phone flow) instead of failing.
   *
   * `chatId` is optional but required to re-link on a duplicate. Returns the contactId to
   * use going forward (may change if we linked to an existing contact). Best-effort.
   */
  async fillContactInfoIfEmpty(locationId, ghlContactId, { phone, email }, chatId) {
    if (!phone && !email) return ghlContactId;
    try {
      const contact = await this.ghlService.getContact(locationId, ghlContactId);
      if (!contact) return ghlContactId;

      const updates = {};
      if (phone && !contact.phone) updates.phone = phone;
      if (email && !contact.email) updates.email = email;
      if (Object.keys(updates).length === 0) return ghlContactId;

      try {
        await this.ghlService.updateContact(locationId, ghlContactId, updates);
        console.log(`[Lead] Filled ${Object.keys(updates).join('+')} from message text for contact ${ghlContactId} (${locationId})`);
        return ghlContactId;
      } catch (updateErr) {
        // "This location does not allow duplicated contacts" — the phone belongs to another
        // contact. Link this chat to that existing contact instead of duplicating.
        const body = updateErr.response?.data;
        const isDuplicate = /duplicat/i.test(body?.message || updateErr.message || '');
        const existingId = body?.meta?.contactId;
        if (isDuplicate && existingId && chatId != null && existingId !== ghlContactId) {
          await ContactMapping.updateOne(
            { locationId, telegramChatId: chatId },
            { ghlContactId: existingId },
          );
          console.log(`[Lead] Phone already on contact ${existingId} — linked chat ${chatId} to it (was ${ghlContactId}) in ${locationId}`);
          return existingId;
        }
        throw updateErr;
      }
    } catch (err) {
      console.warn(`[Lead] fillContactInfoIfEmpty failed for ${ghlContactId} (continuing): ${err.message}`);
      return ghlContactId;
    }
  }

  /**
   * A contact typed a phone and/or email. Proactively look up an existing GHL contact
   * that already has that phone OR email. If one is found (and it's a DIFFERENT contact),
   * re-point this Telegram chat to it so this message and all future messages route into
   * that record. Otherwise fall back to filling the empty field on the current contact.
   * Returns the contactId to use going forward. Best-effort — never throws.
   */
  async matchAndLinkByContactInfo(locationId, chatId, currentContactId, { phone, email }) {
    if (!phone && !email) return currentContactId;
    try {
      // 1. Try to find an existing contact by phone, then email.
      let match = null;
      if (phone && this.ghlService.findContactByPhone) {
        match = await this.ghlService.findContactByPhone(locationId, phone);
      }
      if (!match && email && this.ghlService.findContactByEmail) {
        match = await this.ghlService.findContactByEmail(locationId, email);
      }

      // 2. Found a different existing contact → re-link this chat to it.
      if (match && match.id !== currentContactId) {
        await ContactMapping.updateOne(
          { locationId, telegramChatId: chatId },
          { ghlContactId: match.id },
        );
        console.log(
          `[Lead] Matched typed ${phone ? 'phone' : ''}${phone && email ? '/' : ''}${email ? 'email' : ''} to existing contact ${match.id} — linked chat ${chatId} (was ${currentContactId}) in ${locationId}`,
        );
        return match.id;
      }

      // 3. No existing match → fill the empty field(s) on the current contact.
      return await this.fillContactInfoIfEmpty(locationId, currentContactId, { phone, email }, chatId);
    } catch (err) {
      console.warn(`[Lead] matchAndLinkByContactInfo failed for chat ${chatId} in ${locationId} (continuing): ${err.message}`);
      return currentContactId;
    }
  }

  async getTelegramChatId(locationId, ghlContactId) {
    const mapping = await ContactMapping.findOne({
      locationId,
      ghlContactId,
    });

    return mapping?.telegramChatId || null;
  }

  async getContactMapping(locationId, ghlContactId) {
    return ContactMapping.findOne({ locationId, ghlContactId });
  }

  // Look up the GHL contact for a Telegram chat id (reverse of getTelegramChatId).
  async getGhlContactId(locationId, telegramChatId) {
    const mapping = await ContactMapping.findOne({ locationId, telegramChatId });
    return mapping?.ghlContactId || null;
  }
}

module.exports = ContactMappingService;
