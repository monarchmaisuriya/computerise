import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { SCRIPTS, type ScriptName } from "./engine-scripts";
import { modifierFlags, parseKeyCombo } from "./keys";

// The only module that touches macOS. Every call is execFile with fixed programs (no shell); model
// text reaches them only as one JSON argument.

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
  private readonly scratchDir: string;

  constructor(options: { run: RunFile; scratchDir: string }) {
    this.run = options.run;
    this.scratchDir = options.scratchDir;
  }

  // The input is always a JSON object, so it starts with "{" and osascript never reads it as an option.
  private async script<T>(name: ScriptName, input: object, schema: z.ZodType<T>, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<T> {
    let stdout: string;
    try {
      stdout = await this.run("osascript", ["-l", "JavaScript", "-e", SCRIPTS[name], JSON.stringify(input)], timeoutMs);
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

  status(): Promise<ScreenStatus> {
    return this.script("status", {}, statusSchema);
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

  async type(text: string): Promise<void> {
    if (text.length < 1 || text.length > LIMITS.typeUnits) throw new Error(`Expected 1 to ${LIMITS.typeUnits} characters to type, got ${text.length}`);
    await this.controllableDisplay();
    const units = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
    await this.script("keyboard", { kind: "text", units }, postedSchema, SCRIPT_TIMEOUT_MS + units.length * MS_PER_TYPED_UNIT);
  }

  async key(combo: string, repeat: number): Promise<void> {
    requireIntIn("key repeat", repeat, 1, LIMITS.keyRepeat);
    const { code, flags } = parseKeyCombo(combo);
    await this.controllableDisplay();
    await this.script("keyboard", { kind: "key", code, flags, repeat }, postedSchema, SCRIPT_TIMEOUT_MS + repeat * MS_PER_KEY_PRESS);
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

  // Sent at point size, so a coordinate read off the image is the coordinate to click.
  async screenshot(): Promise<Capture> {
    const { display } = await this.status();
    return { jpeg: await this.capture(["-m"], display.width), width: display.width, height: display.height };
  }

  async zoom(region: Region): Promise<Capture> {
    const [x0, y0, x1, y1] = region;
    if (!region.every(Number.isInteger)) throw new Error(`Expected whole-point region coordinates, got [${region.join(", ")}]`);
    if (x0 >= x1 || y0 >= y1) throw new Error(`Expected a region [x0, y0, x1, y1] with x0 < x1 and y0 < y1, got [${region.join(", ")}]`);
    const { display } = await this.status();
    requireOnDisplay({ x: x0, y: y0 }, display, "region start");
    requireOnDisplay({ x: x1 - 1, y: y1 - 1 }, display, "region end");
    const jpeg = await this.capture(["-R", `${x0},${y0},${x1 - x0},${y1 - y0}`], null);
    return { jpeg, width: (x1 - x0) * display.scale, height: (y1 - y0) * display.scale };
  }

  private async capture(areaArgs: readonly string[], resampleWidth: number | null): Promise<Buffer> {
    await mkdir(this.scratchDir, { recursive: true, mode: 0o700 });
    const raw = join(this.scratchDir, `${randomUUID()}.jpg`);
    const scaled = join(this.scratchDir, `${randomUUID()}.jpg`);
    try {
      try {
        await this.run("screencapture", ["-x", ...areaArgs, "-t", "jpg", raw], CAPTURE_TIMEOUT_MS);
      } catch (error) {
        const text = failureText(error);
        if (text.includes("could not create image")) {
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
