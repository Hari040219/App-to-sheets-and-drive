const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export interface IstStamp {
  /** 2026-10-11 */
  date: string;
  /** 17-55-02 */
  timeDashed: string;
  /** 2026-10-11 17:55:02 */
  display: string;
  /** 2026-10-11-17-55-02 */
  fileStamp: string;
}

/** Current (or given) moment expressed in Indian Standard Time. */
export function istStamp(d: Date = new Date()): IstStamp {
  const parts = formatter.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const hh = get("hour");
  const mm = get("minute");
  const ss = get("second");
  return {
    date,
    timeDashed: `${hh}-${mm}-${ss}`,
    display: `${date} ${hh}:${mm}:${ss}`,
    fileStamp: `${date}-${hh}-${mm}-${ss}`,
  };
}
