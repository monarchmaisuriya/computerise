import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { z } from "zod";

// A missing file is the empty state. An unreadable one is reported, and the caller starts empty,
// which for every store here means nothing is allowed.
export async function readJsonFile<T>(path: string, schema: z.ZodType<T>, empty: T): Promise<{ value: T; problem: string | null }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ENOENT") return { value: empty, problem: null };
    throw error;
  }
  try {
    return { value: schema.parse(JSON.parse(text)), problem: null };
  } catch (error) {
    return { value: empty, problem: `${basename(path)} could not be read (${error instanceof Error ? error.message.slice(0, 200) : String(error)})` };
  }
}

// Written to a temporary file and renamed over, so a crash never leaves half a file.
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
