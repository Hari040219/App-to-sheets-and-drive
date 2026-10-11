/** Reads a trimmed string field of at most `max` chars, or null if missing/invalid. */
export function readString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/** Makes a value safe to embed in a Drive file name (no slashes, controls, etc.). */
export function safeNamePart(value: string, max = 60): string {
  const cleaned = value
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, max);
  return cleaned || "unknown";
}

/** Keeps the extension while limiting total length. */
export function safeOriginalName(value: string, max = 120): string {
  const cleaned = safeNamePart(value, 400);
  if (cleaned.length <= max) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  if (dot > 0 && cleaned.length - dot <= 10) {
    const ext = cleaned.slice(dot);
    return cleaned.slice(0, max - ext.length) + ext;
  }
  return cleaned.slice(0, max);
}
