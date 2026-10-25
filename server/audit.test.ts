import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "./audit";
import { tempDir } from "./test-temp-dir";

describe("the audit log", () => {
  it("writes one JSON line per call in a file only the user can read", async () => {
    const path = join(tempDir("computerise-audit-"), "audit.jsonl");
    const audit = new AuditLog(path);
    await audit.record({ agentId: "agent-x", tool: "type", target: "com.apple.TextEdit", outcome: "ok", chars: 5 });
    const [line] = (await readFile(path, "utf8")).trim().split("\n").map((text) => JSON.parse(text));
    expect(line).toMatchObject({ agentId: "agent-x", tool: "type", target: "com.apple.TextEdit", outcome: "ok", chars: 5 });
    expect(typeof line.time).toBe("string");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("moves the file aside when it would pass the size limit and keeps one previous file", async () => {
    const path = join(tempDir("computerise-audit-"), "audit.jsonl");
    const audit = new AuditLog(path, 300);
    for (let i = 0; i < 12; i += 1) await audit.record({ agentId: `agent-${i}`, tool: "click", target: null, outcome: "ok" });
    expect((await stat(path)).size).toBeLessThanOrEqual(300);
    expect((await stat(`${path}.1`)).size).toBeLessThanOrEqual(300);
    expect(await readFile(path, "utf8")).toContain('"agent-11"');
  });
});
