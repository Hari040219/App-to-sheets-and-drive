import { hasValidAccessCode } from "@/lib/access";
import {
  MAX_BIZ_LEN,
  MAX_DESC_LEN,
  MAX_NAME_LEN,
  MAX_PHONE_LEN,
  MAX_RIG_LEN,
  isAgreementCategory,
  isCategory,
} from "@/lib/constants";
import { ensureUploadFolder } from "@/lib/drive-folders";
import { env, getDrive, getSheets } from "@/lib/google";
import { readString, safeNamePart } from "@/lib/sanitize";
import { istStamp } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---- Main uploads tab ---- */
const UPLOAD_HEADER = [
  "Timestamp (IST)",
  "Date",
  "FO Name",
  "Rig IC Number",
  "Category",
  "Description",
  "File Name",
  "Size (MB)",
  "Drive Link",
];

/* ---- Separate business / collector info tab ---- */
const INFO_HEADER = [
  "Timestamp (IST)",
  "Date",
  "FO Name",
  "Rig IC Number",
  "Business Name",
  "Business ID",
  "Data Collector Height (cm)",
  "Data Collector Phone",
  "Data Collector Email",
];

// Serialise log calls inside one server instance so two simultaneous requests
// on an empty sheet can't both write the header row.
let chain: Promise<unknown> = Promise.resolve();
function serialise<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

function isMissingTabError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unable to parse range/i.test(message);
}

async function ensureTab(tab: string) {
  const sheets = getSheets();
  const spreadsheetId = env("SHEET_ID");
  const q = quoteTab(tab);

  let headerRow: string[] = [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${q}!1:1`,
    });
    headerRow = (res.data.values?.[0] as string[]) ?? [];
  } catch (err) {
    if (!isMissingTabError(err)) throw err;
    // Tab doesn't exist — create it
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
  }

  return { headerRow };
}

/**
 * Append a row to the given tab inside the log spreadsheet.
 * `dedupeValue` is checked against all existing rows to prevent duplicates.
 * If `dedupeValue` is empty the duplicate check is skipped.
 */
async function appendRow(
  tab: string,
  header: string[],
  row: (string | number)[],
  dedupeValue: string,
) {
  const sheets = getSheets();
  const spreadsheetId = env("SHEET_ID");
  const q = quoteTab(tab);

  const { headerRow } = await ensureTab(tab);
  const hasHeader = headerRow.length > 0;

  // De-duplicate if requested
  if (dedupeValue) {
    try {
      const dataRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${q}!A2:Z`,
      });
      const alreadyLogged = (dataRes.data.values ?? []).some((r) =>
        (r as string[]).includes(dedupeValue),
      );
      if (alreadyLogged) return { duplicate: true };
    } catch {
      // No data rows yet — not a duplicate
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${q}!A1`,
    // RAW so a description starting with "=" can never run as a formula.
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: hasHeader ? [row] : [header, row] },
  });
  return { duplicate: false };
}

export async function POST(req: Request) {
  if (!hasValidAccessCode(req)) {
    return Response.json({ error: "Invalid access code" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fileId = readString(body.fileId, 200);
  const foName = readString(body.foName, MAX_NAME_LEN);
  const rigIc = readString(body.rigIc, MAX_RIG_LEN);
  const date = readString(body.date, 10);
  const category = body.category;
  const description =
    typeof body.description === "string" ? body.description.trim().slice(0, MAX_DESC_LEN) : "";
  const businessName = readString(body.businessName, MAX_BIZ_LEN) ?? "";
  const businessId = readString(body.businessId, MAX_RIG_LEN) ?? "";
  const collectorHeight = readString(body.collectorHeight, 20) ?? "";
  const collectorPhone = readString(body.collectorPhone, MAX_PHONE_LEN) ?? "";
  const collectorEmail = readString(body.collectorEmail, MAX_NAME_LEN) ?? "";

  if (!fileId || !foName || !rigIc || !isCategory(category)) {
    return Response.json({ error: "Missing or invalid fields" }, { status: 400 });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "A valid date is required" }, { status: 400 });
  }

  try {
    // Never trust the client: ask Drive what actually got uploaded.
    let file;
    try {
      const res = await getDrive().files.get({
        fileId,
        fields: "id,name,size,mimeType,webViewLink,parents,trashed",
        supportsAllDrives: true,
      });
      file = res.data;
    } catch {
      return Response.json({ error: "File not found in Drive" }, { status: 404 });
    }

    const folderId = await ensureUploadFolder(date, safeNamePart(foName), safeNamePart(rigIc));
    const sizeBytes = Number(file.size ?? 0);

    if (file.trashed || !file.id || !file.name || !file.webViewLink) {
      return Response.json({ error: "File is not available in Drive" }, { status: 409 });
    }
    const isAgreement = isAgreementCategory(category);
    const fileMime = (file.mimeType || "").toLowerCase();
    const isValidMime = isAgreement
      ? fileMime.startsWith("image/") || fileMime.startsWith("video/") || fileMime === "application/pdf"
      : fileMime.startsWith("video/");

    if (!isValidMime) {
      return Response.json(
        { error: isAgreement ? "Uploaded file is not an image, PDF, or video" : "Uploaded file is not a video" },
        { status: 409 },
      );
    }
    if (!file.parents?.includes(folderId)) {
      return Response.json({ error: "File is not in the expected folder" }, { status: 409 });
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return Response.json({ error: "Upload is not complete yet" }, { status: 409 });
    }

    const stamp = istStamp().display;
    const uploadTab = process.env.SHEET_TAB || "Uploads";
    const infoTab = process.env.BUSINESS_TAB || "Business Info";

    // Row for the main uploads sheet
    const uploadRow: (string | number)[] = [
      stamp,
      date,
      foName,
      rigIc,
      category,
      description,
      file.name,
      Math.round((sizeBytes / 1024 / 1024) * 100) / 100,
      file.webViewLink,
    ];

    // Row for the business/collector info sheet
    const infoRow: (string | number)[] = [
      stamp,
      date,
      foName,
      rigIc,
      businessName,
      businessId,
      collectorHeight,
      collectorPhone,
      collectorEmail,
    ];

    const result = await serialise(async () => {
      // 1. Append to main uploads tab (deduplicate by Drive link)
      const uploadResult = await appendRow(
        uploadTab,
        UPLOAD_HEADER,
        uploadRow,
        file.webViewLink as string,
      );

      // 2. Append to business info tab if not already recorded for this session
      if (!uploadResult.duplicate) {
        let alreadyInInfo = false;
        try {
          const sheets = getSheets();
          const infoRes = await sheets.spreadsheets.values.get({
            spreadsheetId: env("SHEET_ID"),
            range: `${quoteTab(infoTab)}!A2:I`,
          });
          alreadyInInfo = (infoRes.data.values ?? []).some(
            (r) => r[1] === date && r[2] === foName && r[3] === rigIc && r[5] === businessId,
          );
        } catch {
          // ignore error if tab or range not yet populated
        }

        if (!alreadyInInfo) {
          await appendRow(infoTab, INFO_HEADER, infoRow, "");
        }
      }

      return uploadResult;
    });

    return Response.json({ ok: true, duplicate: result.duplicate });
  } catch (err) {
    console.error("log error", err);
    return Response.json({ error: "Server error while logging the upload" }, { status: 500 });
  }
}
