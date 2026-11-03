/**
 * Which Claude errors get a card in the chat, keyed by the typed code the server
 * overlay forwards (`errorCode`), never by the English text. A code that is not
 * here (`invalid_request`, `unknown`, anything new from the SDK) keeps today's bubble.
 *
 * `showOriginal`: the original text carries the answer, so it stays in the open
 * instead of under "Details": the reset time of a limit, a truncated reply, and the cause of
 * `server_error`, which covers a refused connection or a firewall as well as a fault at Anthropic
 * (measured on CLI 2.1.316: ECONNREFUSED arrives as `server_error`).
 */
export const CLAUDE_ERROR_CARDS = {
  authentication_failed: { showOriginal: false },
  cloud_credential_error: { showOriginal: false },
  oauth_org_not_allowed: { showOriginal: false },
  account_on_hold: { showOriginal: false },
  verification_required: { showOriginal: false },
  billing_error: { showOriginal: false },
  rate_limit: { showOriginal: true },
  overloaded: { showOriginal: false },
  server_error: { showOriginal: true },
  network: { showOriginal: false },
  model_not_found: { showOriginal: false },
  max_output_tokens: { showOriginal: true },
  not_installed: { showOriginal: false },
} as const;

export function claudeErrorCard(code: unknown): { showOriginal: boolean } | null {
  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(CLAUDE_ERROR_CARDS, code)) {
    return null;
  }
  return CLAUDE_ERROR_CARDS[code as keyof typeof CLAUDE_ERROR_CARDS];
}

/**
 * A failed run reports twice: the assistant row (which survives a reload, so it is
 * the one that becomes the card) and the error row of the same run. One card is enough.
 */
export function dropDuplicateErrorRow(code: unknown, converted: ReadonlyArray<Record<string, unknown>>): boolean {
  return claudeErrorCard(code) !== null && converted[converted.length - 1]?.errorCode === code;
}
