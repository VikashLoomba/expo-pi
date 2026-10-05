/** Provider metadata is untrusted; only ordinary web URLs can become source links. */
export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
