/** Return only the error type; messages can contain Slack body, secret, or prompt text. */
export function safeErrorName(error: unknown): string {
  if (error instanceof Error) return error.constructor.name;
  return "non-error thrown";
}
