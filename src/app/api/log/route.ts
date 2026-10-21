import { hasValidAccessCode } from "@/lib/access";
import { MAX_DESC_LEN, MAX_NAME_LEN, MAX_RIG_LEN, isCategory } from "@/lib/constants";
import { ensureUploadFolder } from "@/lib/drive-folders";
import { env, getDrive, getSheets } from "@/lib/google";
import { readString, safeNamePart } from "@/lib/sanitize";
import { istStamp } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADER = [
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

async function readSheetState(tab: string) {
  const sheets = getSheets();
  const spreadsheetId = env("SHEET_ID");
  const q = quoteTab(tab);
  return sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [`${q}!A1:I1`, `${q}!I2:I`],
  });
}

async function createTab(tab: string) {
  await getSheets().spreadsheets.batchUpdate({
    spreadsheetId: env("SHEET_ID"),
    requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
  });
}

async function appendRow(tab: string, row: (string | number)[], link: string) {
  const sheets = getSheets();
  const spreadsheetId = env("SHEET_ID");

  let state;
  try {
    state = await readSheetState(tab);
  } catch (err) {
    if (!isMissingTabError(err)) throw err;
    await createTab(tab);
    state = await readSheetState(tab);
  }

  const [headerRange, linkRange] = state.data.valueRanges ?? [];
  const hasHeader = (headerRange?.values?.[0]?.length ?? 0) > 0;
  const alreadyLogged = (linkRange?.values ?? []).some((r) => r[0] === link);
  if (alreadyLogged) return { duplicate: true };

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteTab(tab)}!A1`,
    // RAW so a description starting with "=" can never run as a formula.
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: hasHeader ? [row] : [HEADER, row] },
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
    if (!file.mimeType?.startsWith("video/")) {
      return Response.json({ error: "Uploaded file is not a video" }, { status: 409 });
    }
    if (!file.parents?.includes(folderId)) {
      return Response.json({ error: "File is not in the expected folder" }, { status: 409 });
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return Response.json({ error: "Upload is not complete yet" }, { status: 409 });
    }

    const row: (string | number)[] = [
      istStamp().display,
      date,
      foName,
      rigIc,
      category,
      description,
      file.name,
      Math.round((sizeBytes / 1024 / 1024) * 100) / 100,
      file.webViewLink,
    ];

    const tab = process.env.SHEET_TAB || "Uploads";
    const result = await serialise(() => appendRow(tab, row, file.webViewLink as string));

    return Response.json({ ok: true, duplicate: result.duplicate });
  } catch (err) {
    console.error("log error", err);
    return Response.json({ error: "Server error while logging the upload" }, { status: 500 });
  }
}
