/**
 * Translate raw Telegram / axios / internal errors into clear, customer-facing messages
 * that GHL shows in the workflow execution history. Without this, GHL displays unhelpful
 * strings like "Request failed with status code 400" instead of what actually went wrong
 * (e.g. the bot isn't an admin, the group doesn't exist, the contact never started the bot).
 *
 * Strategy: prefer the Telegram API `description` (the real reason), map the common ones
 * to plain-English guidance, and fall back to our own thrown Error messages (which are
 * already written for humans).
 */

// Map fragments of Telegram's `description` → clear guidance. First match wins.
const TELEGRAM_ERROR_MAP = [
  [/not enough rights to manage chat invite link/i,
    'The bot is not an admin in this group (or lacks the "Invite Users via Link" permission). Add the bot as an admin with invite permission.'],
  [/not enough rights/i,
    'The bot does not have the required admin rights in this chat. Make the bot an admin with the needed permissions.'],
  [/chat not found/i,
    'That group/chat could not be found. Use the group\'s numeric ID (e.g. -1001234567890) or its public @username, and make sure the bot is a member of it.'],
  [/user not found/i,
    'That Telegram user could not be found. Check the user ID is correct.'],
  [/can't invite members to a private chat|CHAT_INVALID/i,
    'This is a 1:1 private chat, not a group. Invite links only work for groups. Use a group ID (-100…) or @username.'],
  [/group chat was upgraded to a supergroup chat/i,
    'This group was upgraded to a supergroup and now has a new ID. Get the new -100… ID (e.g. via @getidsbot) and update the Group ID.'],
  [/bot was blocked by the user/i,
    'The contact has blocked the bot on Telegram, so the message could not be delivered.'],
  [/bot can't initiate conversation with a user|chat not found.*bot/i,
    'The contact has not started a chat with the bot yet. A bot can only message users who messaged it first.'],
  [/user is deactivated/i,
    'This Telegram account is deactivated — the message cannot be delivered.'],
  [/message to edit not found|message to delete not found|message to pin not found|message to react not found|message not found/i,
    'That Telegram message no longer exists (it may have been deleted or is too old).'],
  [/message is not modified/i,
    'The message is already showing that text — nothing to edit.'],
  [/CHAT_ADMIN_REQUIRED|need administrator rights/i,
    'The bot must be an admin in this group to perform this action.'],
  [/USER_NOT_PARTICIPANT|user is not a member/i,
    'That user is not a member of the group.'],
  [/not enough rights to restrict\/unrestrict/i,
    'The bot lacks permission to restrict members. Give it the "Ban Users" admin permission.'],
  [/reaction is not valid|REACTION_INVALID/i,
    'That emoji is not a valid Telegram reaction. Use a standard reaction emoji (e.g. ❤️, 👍).'],
  [/wrong file identifier|failed to get HTTP URL content|wrong remote file/i,
    'The file URL could not be fetched by Telegram. Make sure it is a public, direct link to the file.'],
  [/message is too long/i,
    'The message is too long for Telegram (max 4096 characters). Shorten it.'],
  [/not enough rights to send/i,
    'The bot is not allowed to send this content in this chat (check group permissions).'],
  [/flood|too many requests/i,
    'Telegram is rate-limiting this account. Please wait a moment and try again.'],
];

/**
 * Build a clear message for GHL from any error thrown by an action.
 * @returns {string}
 */
function toGhlActionMessage(error) {
  // 1) Telegram API error with a description — the real reason lives here, not in message.
  const description = error?.response?.data?.description;
  if (description) {
    for (const [pattern, friendly] of TELEGRAM_ERROR_MAP) {
      if (pattern.test(description)) return friendly;
    }
    // No specific map hit — surface Telegram's own description (strip the "Bad Request:" prefix).
    return `Telegram rejected the request: ${description.replace(/^Bad Request:\s*/i, '')}`;
  }

  // 2) Our own thrown Error messages are already human-written (validation, "X is required").
  //    Only suppress the generic axios string, which is meaningless to a user.
  const msg = error?.message || '';
  if (msg && !/request failed with status code/i.test(msg)) {
    return msg;
  }

  // 3) Last resort — a status-only axios failure with no description.
  const status = error?.response?.status;
  if (status) return `The action failed (Telegram/HTTP ${status}). Please check the inputs and the bot's permissions.`;
  return 'The action could not be completed. Please check the inputs and try again.';
}

module.exports = { toGhlActionMessage };
