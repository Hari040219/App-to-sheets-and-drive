import { CHUNK_SIZE } from "./constants";

/**
 * Browser-side resumable uploader for Google Drive.
 *
 * Sends the file straight to the Drive session URL in 8 MB chunks using XHR
 * (so we get upload progress events). On network errors / 5xx it backs off,
 * asks Drive how many bytes it has (PUT with "Content-Range: bytes * /total"),
 * and resumes from there.
 */

const MAX_RETRIES = 8;
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;

export class UploadError extends Error {
  /** Fatal errors are not retried automatically. */
  readonly fatal: boolean;
  constructor(message: string, fatal = true) {
    super(message);
    this.name = "UploadError";
    this.fatal = fatal;
  }
}

interface XhrResult {
  status: number;
  range: string | null;
  text: string;
}

function put(
  url: string,
  body: Blob | null,
  contentRange: string,
  onProgress?: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Range", contentRange);
    xhr.timeout = CHUNK_TIMEOUT_MS;

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      };
    }
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        range: xhr.getResponseHeader("Range"),
        text: xhr.responseText,
      });
    xhr.onerror = () => reject(new UploadError("Network error", false));
    xhr.ontimeout = () => reject(new UploadError("Network timeout", false));
    xhr.onabort = () => reject(new UploadError("Upload cancelled", true));

    if (signal) {
      if (signal.aborted) {
        reject(new UploadError("Upload cancelled", true));
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(body);
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new UploadError("Upload cancelled", true));
      },
      { once: true },
    );
  });
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000) + Math.random() * 500;
}

/** "bytes=0-8388607" -> 8388608 (the next offset to send). */
function offsetFromRange(range: string | null): number | null {
  if (!range) return null;
  const match = /bytes=0-(\d+)/.exec(range);
  return match ? Number(match[1]) + 1 : null;
}

function parseFileId(text: string): string {
  try {
    const json = JSON.parse(text) as { id?: unknown };
    if (typeof json.id === "string" && json.id) return json.id;
  } catch {
    // fall through
  }
  throw new UploadError("Drive finished the upload but did not return a file id");
}

function statusError(status: number): UploadError {
  if (status === 404 || status === 410) {
    return new UploadError("Upload session expired — tap Retry to start it again.");
  }
  if (status === 401 || status === 403) {
    return new UploadError(`Google Drive denied the upload (HTTP ${status}).`);
  }
  return new UploadError(`Google Drive rejected the upload (HTTP ${status}).`);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

type Resume = { done: true; id: string } | { done: false; offset: number };

/** Asks Drive how much of the file it already has. */
async function queryStatus(url: string, total: number, signal?: AbortSignal): Promise<Resume> {
  const res = await put(url, null, `bytes */${total}`, undefined, signal);
  if (res.status === 200 || res.status === 201) {
    return { done: true, id: parseFileId(res.text) };
  }
  if (res.status === 308) {
    return { done: false, offset: offsetFromRange(res.range) ?? 0 };
  }
  if (isRetryableStatus(res.status)) throw new UploadError(`HTTP ${res.status}`, false);
  throw statusError(res.status);
}

export interface UploadOptions {
  file: File;
  sessionUrl: string;
  onProgress: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export async function uploadToSession({
  file,
  sessionUrl,
  onProgress,
  signal,
}: UploadOptions): Promise<{ id: string }> {
  const total = file.size;
  let offset = 0;
  let attempt = 0;
  let needsResync = false;

  for (;;) {
    try {
      if (needsResync) {
        const state = await queryStatus(sessionUrl, total, signal);
        if (state.done) {
          onProgress(total, total);
          return { id: state.id };
        }
        offset = state.offset;
        onProgress(offset, total);
        needsResync = false;
      }

      const end = Math.min(offset + CHUNK_SIZE, total);
      const res = await put(
        sessionUrl,
        file.slice(offset, end),
        `bytes ${offset}-${end - 1}/${total}`,
        (loaded) => onProgress(Math.min(offset + loaded, total), total),
        signal,
      );

      if (res.status === 200 || res.status === 201) {
        onProgress(total, total);
        return { id: parseFileId(res.text) };
      }

      if (res.status === 308) {
        // If the Range header isn't readable, assume the whole chunk was accepted;
        // Drive corrects us on the next request if that was wrong.
        const next = offsetFromRange(res.range) ?? end;
        if (next >= total) throw new UploadError("Unexpected response from Google Drive");
        offset = next;
        attempt = 0;
        onProgress(offset, total);
        continue;
      }

      if (isRetryableStatus(res.status)) throw new UploadError(`HTTP ${res.status}`, false);
      throw statusError(res.status);
    } catch (err) {
      if (err instanceof UploadError && err.fatal) throw err;

      attempt += 1;
      if (attempt > MAX_RETRIES) {
        throw new UploadError("Connection kept failing. Check your signal and tap Retry.");
      }
      needsResync = true;
      await sleep(backoff(attempt), signal);
    }
  }
}
