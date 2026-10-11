import { env, getDrive } from "./google";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { id: string; at: number }>();
const inflight = new Map<string, Promise<string>>();

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findOrCreate(name: string): Promise<string> {
  const drive = getDrive();
  const root = env("DRIVE_ROOT_FOLDER_ID");

  const list = await drive.files.list({
    q: `mimeType='${FOLDER_MIME}' and name='${escapeQuery(name)}' and '${escapeQuery(root)}' in parents and trashed=false`,
    fields: "files(id,name)",
    pageSize: 1,
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const existing = list.data.files?.[0]?.id;
  if (existing) return existing;

  const created = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [root] },
    fields: "id",
    supportsAllDrives: true,
  });
  const id = created.data.id;
  if (!id) throw new Error(`Could not create Drive folder "${name}"`);
  return id;
}

/** Finds (or creates) the category sub-folder inside DRIVE_ROOT_FOLDER_ID. */
export function ensureCategoryFolder(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.id);

  const pending = inflight.get(name);
  if (pending) return pending;

  const promise = findOrCreate(name)
    .then((id) => {
      cache.set(name, { id, at: Date.now() });
      return id;
    })
    .finally(() => {
      inflight.delete(name);
    });
  inflight.set(name, promise);
  return promise;
}

export function forgetCategoryFolder(name: string): void {
  cache.delete(name);
}
