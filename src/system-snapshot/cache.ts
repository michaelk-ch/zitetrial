import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const defaultCacheDirectory = path.resolve("userdata/.snapshots");
export function fingerprint(value: unknown): string {
  const json = JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return createHash("sha256").update(json).digest("hex");
}

export async function readCached<T>(directory: string, key: string, validate: (value: unknown) => T): Promise<T | null> {
  let text: string;
  try { text = await readFile(path.join(/* turbopackIgnore: true */ directory, `${key}.json`), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try { return validate(JSON.parse(text)); }
  catch { return null; } // Corrupt or obsolete entries are misses, never accepted results.
}

async function writeCached(directory: string, key: string, value: unknown) {
  await mkdir(directory, { recursive: true });
  const destination = path.join(/* turbopackIgnore: true */ directory, `${key}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}

const pending = new Map<string, Promise<unknown>>();

/** Disk persistence and in-process deduplication, shared by the CLI and API. */
export async function cached<T>(directory: string, key: string, validate: (value: unknown) => T, create: () => Promise<T>) {
  const stored = await readCached(directory, key, validate);
  if (stored !== null) return { value: stored, hit: true };
  const pendingKey = path.resolve(directory, key);
  const existing = pending.get(pendingKey);
  if (existing) return { value: validate(await existing), hit: true };
  const work = Promise.resolve().then(create).then(async (value) => {
    const valid = validate(value);
    await writeCached(directory, key, valid);
    return valid;
  });
  pending.set(pendingKey, work);
  try { return { value: await work, hit: false }; }
  finally { pending.delete(pendingKey); }
}
