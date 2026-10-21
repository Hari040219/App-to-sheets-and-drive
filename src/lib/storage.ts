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
      // date is NOT restored — it defaults to today each session
      const date =
        "date" in parsed && typeof parsed.date === "string" && parsed.date
          ? parsed.date
          : todayIST();
      return { name: parsed.name, rigIc: parsed.rigIc, code: parsed.code, date };
    }
  } catch {
    // storage unavailable or corrupt — treat as not saved
  }
  return null;
}

/** Returns today's date in IST as YYYY-MM-DD. */
export function todayIST(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function saveProfile(profile: Profile): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // private mode / blocked storage: the app still works for this session
  }
}
