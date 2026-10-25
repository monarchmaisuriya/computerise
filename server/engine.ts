import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ScreenRecording } from "../shared/contracts";
import type { ScriptName } from "./engine-scripts";
import { modifierFlags, parseKeyCombo } from "./keys";
import { perCallScripts, type ScriptRunner } from "./script-host";

// The only module that touches macOS. Every call runs a fixed program (no shell); model text
// reaches it only as one JSON argument.

export const LIMITS = {
  typeUnits: 2000,
  clickCount: 3,
  keyRepeat: 20,
  scrollAmount: 20,
  snapshotElements: 400,
} as const;

const SNAPSHOT_BUDGET_MS = 5_000;
const SCRIPT_TIMEOUT_MS = 10_000;
const CAPTURE_TIMEOUT_MS = 10_000;
const MS_PER_TYPED_UNIT = 30;
const MS_PER_KEY_PRESS = 100;
// The read-back cursor position may differ from the target by rounding.
const POINTER_TOLERANCE = 1;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export type RunFile = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;

export const runFile: RunFile = async (file, args, timeoutMs) => {
  const { stdout } = await promisify(execFile)(file, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
  return stdout;
};

export type Point = { x: number; y: number };
export type MouseButton = "left" | "right" | "middle";
export type ScrollDirection = "up" | "down" | "left" | "right";
export type Region = readonly [x0: number, y0: number, x1: number, y1: number];
export type Capture = { jpeg: Buffer; width: number; height: number };

const pointSchema = z.object({ x: z.number(), y: z.number() });
const displaySchema = z.object({ width: z.number().positive(), height: z.number().positive(), scale: z.number().positive() });
const statusSchema = z.object({
  trusted: z.boolean(),
  cursor: pointSchema,
  front: z.object({ name: z.string(), bundleId: z.string().nullable(), pid: z.number().int() }).nullable(),
  display: displaySchema,
});
const windowOwnerSchema = z.object({ pid: z.number().int(), name: z.string(), bundleId: z.string().nullable(), layer: z.number() }).nullable();
const postedSchema = z.object({ posted: z.literal(true) });
const activateSchema = z.object({ running: z.boolean(), activated: z.boolean() });
const appSchema = z.object({ bundleId: z.string(), path: z.string() }).nullable();
const windowsSchema = z.array(z.object({ id: z.number().int().positive(), x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }));
const writtenSchema = z.object({ written: z.literal(true) });
const trustedSchema = z.object({ trusted: z.boolean() });

// Fixed System Settings panes; nothing else is ever opened.
const PRIVACY_PANES = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;
export type PrivacyPane = keyof typeof PRIVACY_PANES;
const snapshotSchema = z.object({
  elements: z.array(
    z.object({
      role: z.string().nullable(),
      label: z.string().nullable(),
      value: z.string().nullable(),
      frame: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
    }),
  ),
  cut: z.boolean(),
});

export type ScreenStatus = z.infer<typeof statusSchema>;
export type Display = z.infer<typeof displaySchema>;
export type WindowOwner = NonNullable<z.infer<typeof windowOwnerSchema>>;
export type AppInfo = NonNullable<z.infer<typeof appSchema>>;
export type UiSnapshot = z.infer<typeof snapshotSchema>;

const BUTTON_NUMBER: Record<MouseButton, number> = { left: 0, right: 1, middle: 2 };
const SCROLL_TICK: Record<ScrollDirection, { dy: number; dx: number }> = {
  up: { dy: 1, dx: 0 },
  down: { dy: -1, dx: 0 },
  left: { dy: 0, dx: 1 },
  right: { dy: 0, dx: -1 },
};

function requireIntIn(what: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Expected ${what} ${min} to ${max}, got ${value}`);
}

function requireOnDisplay(point: Point, display: Display, what = "point"): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error(`Expected finite coordinates for the ${what}, got (${point.x}, ${point.y})`);
  if (point.x < 0 || point.y < 0 || point.x >= display.width || point.y >= display.height) {
    throw new Error(`The ${what} (${point.x}, ${point.y}) is outside the main display (${display.width} x ${display.height} points)`);
  }
}

function requireTrusted(status: ScreenStatus): void {
  if (!status.trusted) throw new Error("Paseo needs Accessibility (System Settings > Privacy & Security > Accessibility) before the computer can be controlled");
}

function requireCursorAt(cursor: Point, target: Point): void {
  if (Math.abs(cursor.x - target.x) > POINTER_TOLERANCE || Math.abs(cursor.y - target.y) > POINTER_TOLERANCE) {
    throw new Error(`The pointer is at (${cursor.x}, ${cursor.y}) after the action, not (${target.x}, ${target.y}); macOS dropped the input`);
  }
}

function requireBundleId(bundleId: string): void {
  if (!BUNDLE_ID.test(bundleId)) throw new Error(`Expected a bundle id like com.apple.TextEdit, got ${JSON.stringify(bundleId)}`);
}

function failureText(error: unknown): string {
  const stderr = Reflect.get(Object(error), "stderr");
  if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

export class MacEngine {
  private readonly run: RunFile;
  private readonly scripts: ScriptRunner;
  private readonly scratchDir: string;
  private captureAccess: ScreenRecording = "unknown";

  constructor(options: { run: RunFile; scratchDir: string; scripts?: ScriptRunner }) {
    this.run = options.run;
    this.scripts = options.scripts ?? perCallScripts(options.run);
    this.scratchDir = options.scratchDir;
  }

  private async script<T>(name: ScriptName, input: object, schema: z.ZodType<T>, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<T> {
    let stdout: string;
    try {
      stdout = await this.scripts.run(name, input, timeoutMs);
    } catch (error) {
      throw new Error(`The ${name} script failed: ${failureText(error)}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`The ${name} script printed ${JSON.stringify(stdout.trim().slice(0, 200))}, not JSON`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new Error(`The ${name} script returned an unexpected shape: ${result.error.message}`);
    return result.data;
  }

  // Stops the macOS step that is running, if the transport can.
  interrupt(): void {
    this.scripts.interrupt?.();
  }

  // What the last capture showed; "unknown" until the first one.
  screenRecording(): ScreenRecording {
    return this.captureAccess;
  }

  status(): Promise<ScreenStatus> {
    return this.script("status", {}, statusSchema);
  }

  async openPrivacySettings(pane: PrivacyPane): Promise<void> {
    try {
      await this.run("open", [PRIVACY_PANES[pane]], SCRIPT_TIMEOUT_MS);
    } catch (error) {
      throw new Error(`Could not open System Settings: ${failureText(error)}`, { cause: error });
    }
  }

  // Asks macOS to show its Accessibility prompt for Paseo; returns whether Paseo is trusted now.
  async promptAccessibility(): Promise<boolean> {
    return (await this.script("promptAccessibility", {}, trustedSchema)).trusted;
  }

  // Captures one point of the menu bar corner and deletes it, so the panel can learn whether Screen
  // Recording is granted before any agent takes a screenshot.
  async checkScreenRecording(): Promise<ScreenRecording> {
    try {
      await this.capture(["-R", "0,0,1,1"], null);
    } catch (error) {
      if (this.captureAccess !== "missing") throw error;
    }
    return this.captureAccess;
  }

  async windowAt(point: Point): Promise<WindowOwner | null> {
    const { display } = await this.status();
    requireOnDisplay(point, display);
    return this.script("windowAt", point, windowOwnerSchema);
  }

  private async controllableDisplay(): Promise<Display> {
    const status = await this.status();
    requireTrusted(status);
    return status.display;
  }

  private async pointer(input: object, end: Point): Promise<void> {
    requireCursorAt(await this.script("pointer", input, pointSchema), end);
  }

  async move(point: Point): Promise<void> {
    requireOnDisplay(point, await this.controllableDisplay());
    await this.pointer({ action: "move", ...point }, point);
  }

  async click(point: Point, options: { button: MouseButton; count: number; modifiers: readonly string[] }): Promise<void> {
    requireIntIn("click count", options.count, 1, LIMITS.clickCount);
    const flags = modifierFlags(options.modifiers);
    requireOnDisplay(point, await this.controllableDisplay());
    await this.pointer({ action: "click", ...point, button: BUTTON_NUMBER[options.button], count: options.count, flags }, point);
  }

  async drag(from: Point, to: Point): Promise<void> {
    const display = await this.controllableDisplay();
    requireOnDisplay(from, display, "drag start");
    requireOnDisplay(to, display, "drag end");
    await this.pointer({ action: "drag", from, to }, to);
  }

  async scroll(point: Point, direction: ScrollDirection, amount: number): Promise<void> {
    requireIntIn("scroll amount", amount, 1, LIMITS.scrollAmount);
    requireOnDisplay(point, await this.controllableDisplay());
    await this.pointer({ action: "scroll", ...point, ...SCROLL_TICK[direction], ticks: amount }, point);
  }

  // receiver is the bundle id of the app the caller checked; keys stop if another app is in front.
  async type(text: string, receiver: string): Promise<void> {
    if (text.length < 1 || text.length > LIMITS.typeUnits) throw new Error(`Expected 1 to ${LIMITS.typeUnits} characters to type, got ${text.length}`);
    requireBundleId(receiver);
    await this.controllableDisplay();
    const units = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
    await this.script("keyboard", { kind: "text", units, receiver }, postedSchema, SCRIPT_TIMEOUT_MS + units.length * MS_PER_TYPED_UNIT);
  }

  async key(combo: string, repeat: number, receiver: string): Promise<void> {
    requireIntIn("key repeat", repeat, 1, LIMITS.keyRepeat);
    const { code, flags } = parseKeyCombo(combo);
    requireBundleId(receiver);
    await this.controllableDisplay();
    await this.script("keyboard", { kind: "key", code, flags, repeat, receiver }, postedSchema, SCRIPT_TIMEOUT_MS + repeat * MS_PER_KEY_PRESS);
  }

  // Brings a running app forward. Callers re-read the screen afterwards: activation is not reliable.
  async activate(bundleId: string): Promise<{ running: boolean; activated: boolean }> {
    requireBundleId(bundleId);
    return this.script("activate", { bundleId }, activateSchema);
  }

  async resolveApp(name: string): Promise<AppInfo | null> {
    if (name.trim() === "" || name.length > 200) throw new Error(`Expected an app name of 1 to 200 characters, got ${JSON.stringify(name.slice(0, 50))}`);
    return this.script("resolveApp", { name }, appSchema);
  }

  // Opens by bundle id, so the app the policy checked is the app that opens.
  async openApp(bundleId: string): Promise<void> {
    requireBundleId(bundleId);
    try {
      await this.run("open", ["-b", bundleId], SCRIPT_TIMEOUT_MS);
    } catch (error) {
      throw new Error(`Could not open ${bundleId}: ${failureText(error)}`, { cause: error });
    }
  }

  async uiSnapshot(pid: number, maxElements: number): Promise<UiSnapshot> {
    requireIntIn("max elements", maxElements, 1, LIMITS.snapshotElements);
    await this.controllableDisplay();
    return this.script("uiSnapshot", { pid, max: maxElements, budgetMs: SNAPSHOT_BUDGET_MS }, snapshotSchema, SCRIPT_TIMEOUT_MS + SNAPSHOT_BUDGET_MS);
  }

  // Sent at point size, so a coordinate read off the image is the coordinate to click. With a process
  // id, only that process's windows are shown and the rest of the display is black.
  async screenshot(onlyPid: number | null = null): Promise<Capture> {
    const { display } = await this.status();
    const jpeg = onlyPid === null ? await this.capture(["-m"], display.width) : await this.composeWindows(onlyPid, [0, 0, display.width, display.height], 1);
    return { jpeg, width: display.width, height: display.height };
  }

  async zoom(region: Region, onlyPid: number | null = null): Promise<Capture> {
    const [x0, y0, x1, y1] = region;
    if (!region.every(Number.isInteger)) throw new Error(`Expected whole-point region coordinates, got [${region.join(", ")}]`);
    if (x0 >= x1 || y0 >= y1) throw new Error(`Expected a region [x0, y0, x1, y1] with x0 < x1 and y0 < y1, got [${region.join(", ")}]`);
    const { display } = await this.status();
    requireOnDisplay({ x: x0, y: y0 }, display, "region start");
    requireOnDisplay({ x: x1 - 1, y: y1 - 1 }, display, "region end");
    const jpeg = onlyPid === null ? await this.capture(["-R", `${x0},${y0},${x1 - x0},${y1 - y0}`], null) : await this.composeWindows(onlyPid, region, display.scale);
    return { jpeg, width: (x1 - x0) * display.scale, height: (y1 - y0) * display.scale };
  }

  // Never falls back to a full-display capture: that would show what the user chose to hide. Each
  // window is captured on its own with screencapture -l, which never includes other apps' windows;
  // CGWindowListCreateImage was used before and began blocking for every window (2026-10-25).
  private async composeWindows(pid: number, region: Region, scale: number): Promise<Buffer> {
    requireIntIn("process id", pid, 1, 2 ** 31 - 1);
    const windows = await this.script("windowsOf", { pid }, windowsSchema);
    if (windows.length === 0) throw new Error("The front app has no windows on screen to show");
    await mkdir(this.scratchDir, { recursive: true, mode: 0o700 });
    const out = join(this.scratchDir, `${randomUUID()}.jpg`);
    const files: string[] = [];
    try {
      const layers = [];
      for (const window of windows) {
        const file = join(this.scratchDir, `${randomUUID()}.png`);
        files.push(file);
        try {
          await this.run("screencapture", ["-x", "-o", "-l", String(window.id), "-t", "png", file], CAPTURE_TIMEOUT_MS);
        } catch (error) {
          // screencapture says the same when the window closed meanwhile, so the permission stays unknown.
          throw new Error(`Could not capture window ${window.id} of the front app (${failureText(error)}): it closed, or Paseo lacks Screen Recording (System Settings > Privacy & Security > Screen Recording)`, { cause: error });
        }
        layers.push({ file, x: window.x, y: window.y, width: window.width, height: window.height });
      }
      await this.script("compose", { region, scale, out, layers }, writtenSchema, CAPTURE_TIMEOUT_MS);
      this.captureAccess = "granted";
      return await readFile(out);
    } finally {
      await Promise.all([out, ...files].map((file) => rm(file, { force: true })));
    }
  }

  private async capture(areaArgs: readonly string[], resampleWidth: number | null): Promise<Buffer> {
    await mkdir(this.scratchDir, { recursive: true, mode: 0o700 });
    const raw = join(this.scratchDir, `${randomUUID()}.jpg`);
    const scaled = join(this.scratchDir, `${randomUUID()}.jpg`);
    try {
      try {
        await this.run("screencapture", ["-x", ...areaArgs, "-t", "jpg", raw], CAPTURE_TIMEOUT_MS);
        this.captureAccess = "granted";
      } catch (error) {
        const text = failureText(error);
        if (text.includes("could not create image")) {
          this.captureAccess = "missing";
          throw new Error("Paseo needs Screen Recording (System Settings > Privacy & Security > Screen Recording), then a Paseo reopen", { cause: error });
        }
        throw new Error(`screencapture failed: ${text}`, { cause: error });
      }
      if (resampleWidth === null) return await readFile(raw);
      await this.run("sips", ["--resampleWidth", String(resampleWidth), "-s", "formatOptions", "70", raw, "--out", scaled], CAPTURE_TIMEOUT_MS);
      return await readFile(scaled);
    } finally {
      await rm(raw, { force: true });
      await rm(scaled, { force: true });
    }
  }
}
