/**
 * Smallest Gmail permission set that implements the current product contract.
 *
 * - gmail.send: dispatch an exact message after the product's approval gate.
 * - gmail.readonly: resolve the mailbox identity, maintain users.watch, and
 *   read reply or delivery-failure messages without mailbox mutation rights.
 *
 * Gmail drafts are not created or modified through the Gmail API. Draft
 * artifacts live inside Workforce OS, so gmail.compose is unnecessary.
 * gmail.modify is also unnecessary because the product never changes Gmail
 * labels, message state, or mailbox content.
 */
export const GMAIL_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;
