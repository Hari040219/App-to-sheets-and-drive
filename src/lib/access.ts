import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Checks the x-access-code header against APP_ACCESS_CODE.
 * An empty / unset APP_ACCESS_CODE disables the check.
 */
export function hasValidAccessCode(req: Request): boolean {
  const expected = process.env.APP_ACCESS_CODE ?? "";
  if (!expected) return true;
  const provided = req.headers.get("x-access-code") ?? "";
  return timingSafeEqual(digest(provided), digest(expected));
}
