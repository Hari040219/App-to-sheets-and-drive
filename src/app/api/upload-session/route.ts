import { hasValidAccessCode } from "@/lib/access";
import {
  MAX_BYTES,
  MAX_NAME_LEN,
  MAX_RIG_LEN,
  isCategory,
} from "@/lib/constants";
import { ensureCategoryFolder, forgetCategoryFolder } from "@/lib/drive-folders";
import { getAccessToken } from "@/lib/google";
import { readString, safeNamePart, safeOriginalName } from "@/lib/sanitize";
import { istStamp } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";

function requestOrigin(req: Request): string {
  const header = req.headers.get("origin");
  if (header) return header;
  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
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

  const category = body.category;
  if (!isCategory(category)) {
    return Response.json({ error: "Unknown category" }, { status: 400 });
  }

  const foName = readString(body.foName, MAX_NAME_LEN);
  const rigIc = readString(body.rigIc, MAX_RIG_LEN);
  const originalName = readString(body.fileName, 300);
  const mimeType = readString(body.mimeType, 100);
  const size = body.size;

  if (!foName || !rigIc) {
    return Response.json({ error: "Name and Rig IC number are required" }, { status: 400 });
  }
  if (!originalName) {
    return Response.json({ error: "File name is required" }, { status: 400 });
  }
  if (!mimeType || !mimeType.toLowerCase().startsWith("video/")) {
    return Response.json({ error: "Only video files can be uploaded" }, { status: 400 });
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    return Response.json({ error: "Invalid file size" }, { status: 400 });
  }
  if (size > MAX_BYTES) {
    return Response.json({ error: "File is larger than the 5 GB limit" }, { status: 413 });
  }

  const driveName = `${istStamp().fileStamp}_${safeNamePart(foName)}_${safeNamePart(rigIc)}_${safeOriginalName(originalName)}`;

  try {
    const folderId = await ensureCategoryFolder(category);
    const accessToken = await getAccessToken();

    const res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(size),
        // Passing the browser's Origin through makes Drive send CORS headers
        // on the session URL, so the browser can PUT chunks straight to it.
        Origin: requestOrigin(req),
      },
      body: JSON.stringify({ name: driveName, parents: [folderId] }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Drive session creation failed", res.status, text.slice(0, 500));
      if (res.status === 404) forgetCategoryFolder(category);
      return Response.json(
        { error: "Google Drive refused to start the upload. Try again shortly." },
        { status: 502 },
      );
    }

    const uploadUrl = res.headers.get("location");
    if (!uploadUrl) {
      console.error("Drive session response had no Location header");
      return Response.json({ error: "Drive did not return an upload session" }, { status: 502 });
    }

    return Response.json({ uploadUrl, fileName: driveName });
  } catch (err) {
    console.error("upload-session error", err);
    return Response.json({ error: "Server error while starting the upload" }, { status: 500 });
  }
}
