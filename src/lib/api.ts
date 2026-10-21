import type { Category } from "./constants";
import { guessVideoMime } from "./format";

export interface Profile {
  name: string;
  rigIc: string;
  code: string;
  /** IST date chosen by the FO, e.g. "2026-10-22" */
  date: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function postJson<T>(url: string, profile: Profile, payload: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-access-code": profile.code,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and retry.", 0);
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON error body
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new ApiError("Wrong access code. Tap “Change” at the top to fix it.", 401);
    }
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `Server error (HTTP ${res.status})`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export function createSession(profile: Profile, category: Category, file: File) {
  const clientOrigin = typeof window !== "undefined" ? window.location.origin : "";
  return postJson<{ uploadUrl: string; fileName: string }>("/api/upload-session", profile, {
    category,
    date: profile.date,
    foName: profile.name,
    rigIc: profile.rigIc,
    fileName: file.name || "video",
    mimeType: file.type || guessVideoMime(file.name),
    size: file.size,
    clientOrigin,
  });
}

export function logUpload(
  profile: Profile,
  category: Category,
  description: string,
  fileId: string,
) {
  return postJson<{ ok: true; duplicate: boolean }>("/api/log", profile, {
    fileId,
    category,
    date: profile.date,
    description,
    foName: profile.name,
    rigIc: profile.rigIc,
  });
}
