import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { hostProgram } from "./engine-scripts";
import { ScriptHost } from "./script-host";
import { tempDir } from "./test-temp-dir";

// Tiny programs with the same shape as the engine's: one JSON argument in, one JSON string out.
const TEST_SCRIPTS = {
  echo: "function run(argv) { return argv[0]; }",
  pid: "ObjC.import('Foundation'); function run() { return JSON.stringify({ pid: $.NSProcessInfo.processInfo.processIdentifier }); }",
  sleep: "function run(argv) { delay(JSON.parse(argv[0]).seconds); return '{}'; }",
  fail: "function run() { throw new Error('the script gave up'); }",
  crash: "ObjC.import('stdlib'); function run() { $.exit(3); }",
};

describe.runIf(process.platform === "darwin")("the long-lived script host", () => {
  let host: ScriptHost<keyof typeof TEST_SCRIPTS>;
  afterEach(() => host?.close());

  it("answers many requests from one osascript process", async () => {
    host = new ScriptHost(TEST_SCRIPTS);
    expect(await host.run("echo", { a: "quote \" and \\ and 🙂" }, 5_000)).toBe('{"a":"quote \\" and \\\\ and 🙂"}');
    const first = await host.run("pid", {}, 5_000);
    for (let i = 0; i < 5; i++) expect(await host.run("pid", {}, 5_000)).toBe(first);
  });

  it("rejects with the script's own error and keeps serving", async () => {
    host = new ScriptHost(TEST_SCRIPTS);
    const before = await host.run("pid", {}, 5_000);
    await expect(host.run("fail", {}, 5_000)).rejects.toThrow("the script gave up");
    expect(await host.run("pid", {}, 5_000)).toBe(before);
  });

  it("kills a host that misses the deadline, fails the call, and starts a new host for the next call", async () => {
    host = new ScriptHost(TEST_SCRIPTS);
    const before = await host.run("pid", {}, 5_000);
    await expect(host.run("sleep", { seconds: 5 }, 300)).rejects.toThrow("The sleep script did not answer within 300 ms; the script host was restarted");
    const after = await host.run("pid", {}, 5_000);
    expect(after).not.toBe(before);
  });

  it("fails every waiting call when the host dies, then starts a new host", async () => {
    host = new ScriptHost(TEST_SCRIPTS);
    await host.run("pid", {}, 5_000);
    const crashed = host.run("crash", {}, 5_000);
    const queued = host.run("echo", { queued: true }, 5_000);
    await expect(crashed).rejects.toThrow("The script host exited");
    await expect(queued).rejects.toThrow("The script host exited");
    expect(await host.run("echo", { again: true }, 5_000)).toBe('{"again":true}');
  });

  it("starts a request's deadline when the host begins it, not while it waits behind a long one", async () => {
    host = new ScriptHost(TEST_SCRIPTS);
    const before = await host.run("pid", {}, 5_000);
    const long = host.run("sleep", { seconds: 0.6 }, 5_000);
    const quick = host.run("pid", {}, 300);
    await expect(long).resolves.toBe("{}");
    await expect(quick).resolves.toBe(before);
  });

  it("exits by itself when its input closes, so it never outlives the plugin process", async () => {
    const child = spawn("osascript", ["-l", "JavaScript", "-e", hostProgram(TEST_SCRIPTS)]);
    const replies: string[] = [];
    child.stdout.setEncoding("utf8").on("data", (text: string) => replies.push(text));
    child.stdin.end(`${JSON.stringify({ id: 1, name: "echo", input: { done: true } })}\n`);
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).toBe(0);
    expect(replies.join("")).toBe('{"id":1,"out":"{\\"done\\":true}"}\n');
  });

  it("refuses an unknown script name without asking the host", async () => {
    host = new ScriptHost(TEST_SCRIPTS);
    await expect(host.run("missing" as never, {}, 5_000)).rejects.toThrow('Unknown script "missing"');
  });

  it("refuses every call after close and leaves no host running", async () => {
    host = new ScriptHost(TEST_SCRIPTS);
    const pid = JSON.parse(await host.run("pid", {}, 5_000)).pid as number;
    host.close();
    await expect(host.run("pid", {}, 5_000)).rejects.toThrow("The script host is closed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("compiles the production host program", async () => {
    const out = join(tempDir("computerise-host-"), "host.scpt");
    await promisify(execFile)("osacompile", ["-l", "JavaScript", "-e", hostProgram(), "-o", out]);
    expect(existsSync(out)).toBe(true);
  });
});
