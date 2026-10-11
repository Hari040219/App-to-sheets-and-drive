export const CATEGORIES = [
  "Pre Check",
  "Pre Pack",
  "Rig Installation",
  "Post Check",
  "Post Pack",
  "Rig Issue",
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

/** Largest single video accepted (Drive allows far more; this is our own cap). */
export const MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

/** Upload chunk size. Must be a multiple of 256 KB for Drive's resumable protocol. */
export const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB

export const MAX_NAME_LEN = 100;
export const MAX_RIG_LEN = 50;
export const MAX_DESC_LEN = 2000;
