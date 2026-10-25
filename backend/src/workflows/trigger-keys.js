/**
 * Single source of truth for every workflow TRIGGER key and ACTION route this app
 * exposes to GHL. Previously these were scattered as string literals across
 * webhooks.router.js and gramjs.service.js, which risked typos and drift against
 * what's registered in the GHL Marketplace dashboard.
 *
 * IMPORTANT: the string VALUES here must match exactly what you register in the GHL
 * Marketplace app (trigger keys) and the action execution URLs (action routes).
 * Changing a value here without updating the dashboard breaks that trigger/action.
 */

// Trigger keys — fired to GHL via WorkflowsService.fireTrigger(key, ...).
const TRIGGERS = {
  MESSAGE_RECEIVED: 'telegram_message_received',
  NEW_CONTACT: 'new_telegram_contact',
  BOT_COMMAND: 'telegram_bot_command',
  MEDIA_RECEIVED: 'telegram_media_received',
  CONTACT_REACTIVATED: 'telegram_contact_reactivated',
  AGENT_REPLY: 'telegram_agent_reply',
  MESSAGE_FAILED: 'telegram_message_failed',
  // Added: inline-button taps (callback_query)
  BUTTON_CLICKED: 'telegram_button_clicked',
  // Added: group membership + bot block status (chat_member / my_chat_member)
  MEMBER_JOINED: 'telegram_member_joined',
  MEMBER_LEFT: 'telegram_member_left',
  BOT_BLOCKED: 'telegram_bot_blocked',
  BOT_UNBLOCKED: 'telegram_bot_unblocked',
  // Added: message edited (we already ingest edited_message)
  MESSAGE_EDITED: 'telegram_message_edited',
};

// Action route segments (mounted under /workflows/actions/...).
const ACTIONS = {
  SEND_MESSAGE: 'send-message',
  SEND_BUTTONS: 'send-buttons',
  FORWARD_MESSAGE: 'forward-message',
  EDIT_MESSAGE: 'edit-message',
  DELETE_MESSAGE: 'delete-message',
  SEND_PHONE_MESSAGE: 'send-phone-message',
  SEND_TO_GROUP: 'send-to-group',
  SEND_REACTION: 'send-reaction',
  GENERATE_INVITE_LINK: 'generate-invite-link',
  PIN_MESSAGE: 'pin-message',
  EDIT_GROUP_PERMISSIONS: 'edit-group-permissions',
  REMOVE_FROM_GROUP: 'remove-from-group',
  // Added: acknowledge an inline-button tap
  ANSWER_CALLBACK: 'answer-callback',
};

module.exports = { TRIGGERS, ACTIONS };
