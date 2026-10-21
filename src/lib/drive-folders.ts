import { env, getDrive } from "./google";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { id: string; at: number }>();
const inflight = new Map<string, Promise<string>>();

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Finds a child folder named `name` under `parentId`, or creates one.
 * Results are cached with a 10-minute TTL and de-duplicated in flight.
 */
function findOrCreate(name: string, parentId: string): Promise<string> {
  const cacheKey = `${parentId}/${name}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.id);

  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    const drive = getDrive();
    const list = await drive.files.list({
      q: `mimeType='${FOLDER_MIME}' and name='${escapeQuery(name)}' and '${escapeQuery(parentId)}' in parents and trashed=false`,
      fields: "files(id,name)",
      pageSize: 1,
      spaces: "drive",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const existing = list.data.files?.[0]?.id;
    if (existing) return existing;

    const created = await drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
      fields: "id",
      supportsAllDrives: true,
    });
    const id = created.data.id;
    if (!id) throw new Error(`Could not create Drive folder "${name}"`);
    return id;
  })()
    .then((id) => {
      cache.set(cacheKey, { id, at: Date.now() });
      return id;
    })
    .finally(() => {
      inflight.delete(cacheKey);
    });

  inflight.set(cacheKey, promise);
  return promise;
}

/**
 * Ensures the full folder chain exists:
 *   DRIVE_ROOT / date / foName / rigIc
 * and returns the leaf (rigIc) folder's ID.
 */
export async function ensureUploadFolder(
  date: string,
  foName: string,
  rigIc: string,
): Promise<string> {
  const root = env("DRIVE_ROOT_FOLDER_ID");
  const dateId = await findOrCreate(date, root);
  const foId = await findOrCreate(foName, dateId);
  const rigId = await findOrCreate(rigIc, foId);
  return rigId;
}

/** Evicts cache entries for the given folder chain. */
export function forgetUploadFolder(date: string, foName: string, rigIc: string): void {
  const root = env("DRIVE_ROOT_FOLDER_ID");
  const dateKey = `${root}/${date}`;
  const foKey = `${dateKey}/${foName}`;
  const rigKey = `${foKey}/${rigIc}`;
  for (const key of [dateKey, foKey, rigKey]) {
    cache.delete(key);
  }
}
