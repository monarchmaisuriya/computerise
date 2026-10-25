export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { requestType, code } = error as Error & { requestType?: unknown; code?: unknown };
  let message = error.message;
  if (typeof code === "string" && message.endsWith(` code=${code}`)) message = message.slice(0, -` code=${code}`.length);
  if (typeof requestType === "string" && message.endsWith(` requestType=${requestType}`)) message = message.slice(0, -` requestType=${requestType}`.length);
  if (code === "handler_error" && message.startsWith("Request failed: ")) message = message.slice("Request failed: ".length);
  return message;
}
