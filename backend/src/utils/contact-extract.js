/**
 * Extract a phone number and/or email from free-text message content, so a contact who
 * TYPES their details into the Telegram chat (e.g. "call me on +1 555 123 4567, email
 * me@x.com") gets them captured on their GHL contact. Mirrors GHL's own
 * processPhoneEmailMatches: it only returns a value for a field, the caller fills it
 * ONLY IF that field is empty (never overwrite a real value a human set).
 *
 * Note: phone validation here is lightweight (regex + E.164 normalization). For strict
 * validation by country, add `google-libphonenumber` and swap in isValidNumber — the
 * shape below is intentionally compatible with that upgrade.
 */

// Same phone pattern GHL uses for non-livechat text.
const PHONE_RE = /([+]?\d{1,4}[.\-\s]?)?(\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\d{3}[-.\s]?\d{6})/g;

// Standard email pattern (trimmed to the common, safe form).
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Normalize a loosely-formatted phone string to E.164-ish (+digits). Returns null if it
 * doesn't look like a real phone (too short/long). `defaultCountryCode` (e.g. '1', '44')
 * is prepended when the number has no leading '+' and looks like a local number.
 */
function normalizePhone(raw, defaultCountryCode) {
  if (!raw) return null;
  const hadPlus = String(raw).trim().startsWith('+');
  let digits = String(raw).replace(/[^\d]/g, '');
  if (!digits) return null;

  if (!hadPlus) {
    // 10-digit local number + a default country code → prepend it.
    if (digits.length === 10 && defaultCountryCode) {
      digits = `${defaultCountryCode}${digits}`;
    }
  }
  // E.164 is 8–15 digits; reject anything outside a sane range.
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/**
 * Pull the first valid phone and first email out of text.
 * @returns {{ phone: string|null, email: string|null }}
 */
function extractContactInfo(text, { defaultCountryCode } = {}) {
  const out = { phone: null, email: null };
  if (!text || typeof text !== 'string') return out;

  const phoneMatches = text.match(PHONE_RE);
  if (phoneMatches) {
    for (const m of phoneMatches) {
      const normalized = normalizePhone(m, defaultCountryCode);
      if (normalized) { out.phone = normalized; break; }
    }
  }

  const emailMatches = text.match(EMAIL_RE);
  if (emailMatches && emailMatches.length > 0) {
    out.email = emailMatches[0].toLowerCase();
  }

  return out;
}

module.exports = { extractContactInfo, normalizePhone };
