export type EmailBodyContentType = "text" | "html";

export function isEmailBodyContentType(
  value: unknown,
): value is EmailBodyContentType {
  return value === "text" || value === "html";
}

/**
 * Legacy callers may omit an explicit body format. Keep this inference in one
 * place so approval and provider dispatch cannot disagree about how the same
 * bytes will be rendered.
 */
export function inferEmailBodyContentType(
  body: string,
): EmailBodyContentType {
  return /<\/?(html|body|p|div|br|a|span|table|h[1-6])\b/i.test(body)
    ? "html"
    : "text";
}
