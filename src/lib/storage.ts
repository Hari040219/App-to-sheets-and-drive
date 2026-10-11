import type { Profile } from "./api";

const KEY = "fo-video-upload:profile";

export function loadProfile(): Profile | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "name" in parsed &&
      "rigIc" in parsed &&
      "code" in parsed &&
      typeof parsed.name === "string" &&
      typeof parsed.rigIc === "string" &&
      typeof parsed.code === "string" &&
      parsed.name &&
      parsed.rigIc
    ) {
      return { name: parsed.name, rigIc: parsed.rigIc, code: parsed.code };
    }
  } catch {
    // storage unavailable or corrupt — treat as not saved
  }
  return null;
}

export function saveProfile(profile: Profile): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // private mode / blocked storage: the app still works for this session
  }
}
