/**
 * Error types shared across the chat handler's layers.
 *
 * The distinction that matters: a ValidationError is the model's fault (it
 * called a tool with arguments that don't make sense) and must be handed
 * BACK to the model as a tool result so it can correct itself in one step.
 * A ProviderError is our fault or the upstream's, and aborts the turn.
 */

/** Bad tool arguments. Carries `hint` — the valid options — so the model can retry correctly. */
export class ValidationError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = "ValidationError";
    this.hint = hint;
  }
}

/** Any failure talking to the model provider. */
export class ProviderError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

/** Provider returned 429 after exhausting retries — surfaced to the user as "try again shortly". */
export class RateLimitError extends ProviderError {
  constructor(message) {
    super(message, { status: 429 });
    this.name = "RateLimitError";
  }
}
