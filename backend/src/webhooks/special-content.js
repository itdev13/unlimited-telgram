/**
 * Render Telegram "special" message content (location, venue, contact, poll, dice)
 * into readable text for the GHL conversation. Without this, these messages sync as
 * an empty thread entry — the customer sent something, the agent sees nothing.
 *
 * Works off the Bot API message shape. The phone (MTProto) path passes a normalized
 * object with the same field names where possible.
 */
function describeSpecialContent(message) {
  if (!message || typeof message !== 'object') return '';

  // Venue (named place) MUST be checked before location: Telegram sends a venue with
  // BOTH message.venue AND message.location (for backward compatibility). Checking
  // location first would render a venue as a plain map link and drop its name/address.
  if (message.venue) {
    const { title, address, location } = message.venue;
    const parts = [title, address].filter(Boolean).join(', ');
    const map = location ? ` https://maps.google.com/?q=${location.latitude},${location.longitude}` : '';
    return `[Venue] ${parts}${map}`.trim();
  }

  // Location / live location (plain, no venue attached)
  if (message.location) {
    const { latitude, longitude } = message.location;
    if (latitude != null && longitude != null) {
      return `[Location] https://maps.google.com/?q=${latitude},${longitude}`;
    }
  }

  // Shared contact (vCard)
  if (message.contact) {
    const { first_name, last_name, phone_number } = message.contact;
    const name = [first_name, last_name].filter(Boolean).join(' ');
    return `[Contact] ${[name, phone_number].filter(Boolean).join(' · ')}`.trim();
  }

  // Poll
  if (message.poll) {
    const q = message.poll.question || '';
    const opts = Array.isArray(message.poll.options)
      ? message.poll.options.map((o) => o.text).filter(Boolean)
      : [];
    const optLine = opts.length ? `\n- ${opts.join('\n- ')}` : '';
    return `[Poll] ${q}${optLine}`.trim();
  }

  // Dice / dart / slot animation
  if (message.dice) {
    return `[${message.dice.emoji || '🎲'}] value: ${message.dice.value}`;
  }

  return '';
}

module.exports = { describeSpecialContent };
