import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settingsSchema } from "../shared/contracts";
import { blockLevel, ControlStore, Failsafe, Lease, LeaseHeldError, RateLimiter } from "./policy";
import { tempDir } from "./test-temp-dir";

const defaults = settingsSchema.parse({});

describe("the blocklist", () => {
  it("blocks input to Paseo, terminals, code runners, and System Settings, and viewing of password managers", () => {
    expect(blockLevel("sh.paseo.desktop", defaults)).toBe("no-input");
    expect(blockLevel("com.apple.Terminal", defaults)).toBe("no-input");
    expect(blockLevel("com.apple.ScriptEditor2", defaults)).toBe("no-input");
    expect(blockLevel("com.anthropic.claudefordesktop", defaults)).toBe("no-input");
    expect(blockLevel("com.apple.systempreferences", defaults)).toBe("no-input");
    expect(blockLevel("com.1password.1password", defaults)).toBe("no-view");
    expect(blockLevel("com.apple.TextEdit", defaults)).toBe("none");
  });

  it("treats an app it cannot identify as blocked for input", () => {
    expect(blockLevel(null, defaults)).toBe("no-input");
  });

  it("lets the user add apps and switch built-ins off, except Paseo", () => {
    const settings = settingsSchema.parse({
      extraNoInput: ["com.apple.Notes"],
      extraNoView: ["com.apple.mail"],
      disabledBuiltIns: ["com.apple.Terminal", "sh.paseo.desktop"],
    });
    expect(blockLevel("com.apple.Notes", settings)).toBe("no-input");
    expect(blockLevel("com.apple.mail", settings)).toBe("no-view");
    expect(blockLevel("com.apple.Terminal", settings)).toBe("none");
    expect(blockLevel("sh.paseo.desktop", settings)).toBe("no-input");
  });

  it("matches bundle ids exactly, not by prefix or case", () => {
    expect(blockLevel("com.apple.Terminal.helper", defaults)).toBe("none");
    expect(blockLevel("com.apple.terminal", defaults)).toBe("none");
  });
});

describe("the settings document", () => {
  it("defaults the approval timeout to 45 seconds and refuses values outside 5 to 55", () => {
    expect(defaults.approvalTimeoutSeconds).toBe(45);
    expect(settingsSchema.safeParse({ approvalTimeoutSeconds: 0 }).success).toBe(false);
    expect(settingsSchema.safeParse({ approvalTimeoutSeconds: 56 }).success).toBe(false);
    expect(settingsSchema.safeParse({ extraNoInput: ["not a bundle id; rm"] }).success).toBe(false);
  });
});

describe("the lease", () => {
  it("lets one agent hold the screen and refuses another, naming the holder", () => {
    const lease = new Lease(120_000, () => 0);
    lease.take("agent-x");
    lease.take("agent-x");
    expect(() => lease.take("agent-y")).toThrow(LeaseHeldError);
    try {
      lease.take("agent-y");
    } catch (error) {
      expect((error as LeaseHeldError).holder).toBe("agent-x");
    }
  });

  it("frees the screen after 120 seconds without a call, on release, and on release of all", () => {
    let now = 0;
    const lease = new Lease(120_000, () => now);
    lease.take("agent-x");
    now = 119_999;
    expect(() => lease.take("agent-y")).toThrow(LeaseHeldError);
    now = 119_999 + 120_000;
    lease.take("agent-y");
    lease.release("agent-y");
    lease.take("agent-x");
    lease.releaseAll();
    lease.take("agent-y");
  });

  it("keeps the working app with the holder and drops it with the lease", () => {
    const lease = new Lease(120_000, () => 0);
    lease.take("agent-x");
    lease.setWorkingApp("agent-x", { bundleId: "com.apple.TextEdit", name: "TextEdit" });
    expect(lease.workingApp("agent-x")).toEqual({ bundleId: "com.apple.TextEdit", name: "TextEdit" });
    expect(lease.workingApp("agent-y")).toBeNull();
    lease.release("agent-x");
    lease.take("agent-x");
    expect(lease.workingApp("agent-x")).toBeNull();
  });
});

describe("the rate limit", () => {
  it("allows 60 actions per agent per minute and refuses the 61st", () => {
    let now = 0;
    const rates = new RateLimiter(60, 60_000, () => now);
    for (let i = 0; i < 60; i += 1) rates.take("agent-x");
    expect(() => rates.take("agent-x")).toThrow("Refused: 60 actions in the last minute");
    rates.take("agent-y");
    now = 60_000;
    rates.take("agent-x");
  });
});

describe("the corner failsafe", () => {
  it("trips when the pointer is in the top-left corner and the plugin did not put it there", () => {
    const failsafe = new Failsafe();
    expect(failsafe.tripped({ x: 1.5, y: 0 })).toBe(true);
    expect(failsafe.tripped({ x: 3, y: 0 })).toBe(false);
    failsafe.notePlaced({ x: 0, y: 0 });
    expect(failsafe.tripped({ x: 0, y: 0 })).toBe(false);
    failsafe.notePlaced({ x: 400, y: 300 });
    expect(failsafe.tripped({ x: 0, y: 1 })).toBe(true);
  });
});

describe("modes and the global stop", () => {
  it("defaults every agent to off and keeps modes and the stop across reopening", async () => {
    const path = join(tempDir("computerise-control-"), "control.json");
    const control = await ControlStore.open(path);
    expect(control.mode("agent-x")).toBe("off");
    expect(control.stopped()).toBe(false);
    await control.setMode("agent-x", "ask");
    await control.setStopped(true);
    const reopened = await ControlStore.open(path);
    expect(reopened.mode("agent-x")).toBe("ask");
    expect(reopened.mode("agent-y")).toBe("off");
    expect(reopened.stopped()).toBe(true);
  });

  it("turns every agent off when the file cannot be read, and says why", async () => {
    const path = join(tempDir("computerise-control-"), "control.json");
    await writeFile(path, "{ not json");
    const control = await ControlStore.open(path);
    expect(control.mode("agent-x")).toBe("off");
    expect(control.problem).toMatch(/control.json could not be read/);
    await control.setMode("agent-x", "auto");
    expect(JSON.parse(await readFile(path, "utf8")).modes).toEqual({ "agent-x": "auto" });
  });
});
