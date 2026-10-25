import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const made: string[] = [];

// Registered once per test file that imports this module. It runs after the file's own afterEach
// hooks, so servers and timers they stop are already closed when the folders go. It uses node:fs,
// not node:fs/promises, so tests that mock node:fs/promises do not see these calls.
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A fresh folder in the OS temp folder, removed after the current test.
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
