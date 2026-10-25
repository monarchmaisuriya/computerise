import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MacEngine, type RunFile } from "./engine";
import { SCRIPTS, type ScriptName } from "./engine-scripts";
import { tempDir } from "./test-temp-dir";

type Call = { file: string; args: readonly string[] };

const DISPLAY = { width: 1512, height: 982, scale: 2 };

function scriptName(args: readonly string[]): ScriptName {
  const entry = Object.entries(SCRIPTS).find(([, source]) => source === args[3]);
  if (!entry) throw new Error("osascript was called with a script that is not in SCRIPTS");
  return entry[0] as ScriptName;
}

function scriptInput(call: Call): Record<string, unknown> {
  return JSON.parse(call.args[4]);
}

// A stand-in for execFile that records every call and answers each script like macOS would.
function fakeMac(options: { trusted?: boolean; cursorAfter?: (input: Record<string, unknown>) => { x: number; y: number }; composed?: { drawn: number; windows: number } } = {}) {
  const calls: Call[] = [];
  const run: RunFile = async (file, args) => {
    calls.push({ file, args });
    if (file === "screencapture") {
      await writeFile(args[args.length - 1], "raw-jpeg");
      return "";
    }
    if (file === "sips") {
      await writeFile(args[args.length - 1], "small-jpeg");
      return "";
    }
    if (file !== "osascript") return "";
    const input = JSON.parse(args[4]);
    switch (scriptName(args)) {
      case "status":
        return JSON.stringify({ trusted: options.trusted ?? true, cursor: { x: 5, y: 5 }, front: { name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 42 }, display: DISPLAY });
      case "pointer": {
        const end = input.action === "drag" ? input.to : { x: input.x, y: input.y };
        return JSON.stringify(options.cursorAfter ? options.cursorAfter(input) : end);
      }
      case "keyboard":
        return JSON.stringify({ posted: true });
      case "compose":
        await writeFile(input.out, "composed-jpeg");
        return JSON.stringify(options.composed ?? { drawn: 1, windows: 1 });
      default:
        throw new Error(`fakeMac has no answer for ${scriptName(args)}`);
    }
  };
  return { calls, run };
}

function engineOn(mac: ReturnType<typeof fakeMac>) {
  return new MacEngine({ run: mac.run, scratchDir: tempDir("computerise-engine-") });
}

describe("passing model text to macOS", () => {
  it("sends typed text as one JSON argv entry to a fixed script, so quotes and $(...) are typed, never run", async () => {
    const mac = fakeMac();
    const text = 'He said "hi" \\ $(touch /tmp/pwned) `id` \' ; rm -rf ~\n 🙂';
    await engineOn(mac).type(text);
    const keyboard = mac.calls.filter((call) => call.file === "osascript" && scriptName(call.args) === "keyboard");
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0].args).toHaveLength(5);
    expect(keyboard[0].args.slice(0, 4)).toEqual(["-l", "JavaScript", "-e", SCRIPTS.keyboard]);
    const units = scriptInput(keyboard[0]).units as number[];
    expect(String.fromCharCode(...units)).toBe(text);
    for (const source of Object.values(SCRIPTS)) expect(source).not.toContain("pwned");
  });

  it("refuses empty text and text over 2000 UTF-16 units before touching macOS", async () => {
    const mac = fakeMac();
    const engine = engineOn(mac);
    await expect(engine.type("")).rejects.toThrow("Expected 1 to 2000 characters to type, got 0");
    await expect(engine.type("x".repeat(2001))).rejects.toThrow("Expected 1 to 2000 characters to type, got 2001");
    expect(mac.calls).toHaveLength(0);
  });

  it("opens an app by a validated bundle id only", async () => {
    const mac = fakeMac();
    const engine = engineOn(mac);
    await engine.openApp("com.apple.TextEdit");
    expect(mac.calls).toEqual([{ file: "open", args: ["-b", "com.apple.TextEdit"] }]);
    await expect(engine.openApp("x; rm -rf ~")).rejects.toThrow('Expected a bundle id like com.apple.TextEdit, got "x; rm -rf ~"');
    await expect(engine.openApp("-a")).rejects.toThrow('Expected a bundle id like com.apple.TextEdit, got "-a"');
    expect(mac.calls).toHaveLength(1);
  });
});

describe("pointer and keyboard actions", () => {
  it("clicks with the button, count, and modifier flags it was given", async () => {
    const mac = fakeMac();
    await engineOn(mac).click({ x: 400, y: 220 }, { button: "right", count: 2, modifiers: ["cmd", "shift"] });
    const pointer = mac.calls.find((call) => call.file === "osascript" && scriptName(call.args) === "pointer");
    expect(scriptInput(pointer!)).toEqual({ action: "click", x: 400, y: 220, button: 1, count: 2, flags: 0x100000 | 0x20000 });
  });

  it("refuses every input action when Paseo lacks Accessibility, before posting anything", async () => {
    const mac = fakeMac({ trusted: false });
    const engine = engineOn(mac);
    const actions = [
      () => engine.click({ x: 10, y: 10 }, { button: "left", count: 1, modifiers: [] }),
      () => engine.move({ x: 10, y: 10 }),
      () => engine.drag({ x: 10, y: 10 }, { x: 20, y: 20 }),
      () => engine.scroll({ x: 10, y: 10 }, "down", 3),
      () => engine.type("hello"),
      () => engine.key("cmd+s", 1),
    ];
    for (const action of actions) await expect(action()).rejects.toThrow("Paseo needs Accessibility");
    expect(mac.calls.every((call) => scriptName(call.args) === "status")).toBe(true);
  });

  it("refuses points off the main display instead of clamping them", async () => {
    const mac = fakeMac();
    const engine = engineOn(mac);
    await expect(engine.move({ x: 1512, y: 10 })).rejects.toThrow("The point (1512, 10) is outside the main display (1512 x 982 points)");
    await expect(engine.move({ x: -1, y: 10 })).rejects.toThrow("outside the main display");
    await expect(engine.move({ x: Number.NaN, y: 10 })).rejects.toThrow("Expected finite coordinates for the point, got (NaN, 10)");
    await expect(engine.drag({ x: 10, y: 10 }, { x: 10, y: 982 })).rejects.toThrow("The drag end (10, 982) is outside the main display");
    expect(mac.calls.some((call) => scriptName(call.args) === "pointer")).toBe(false);
  });

  it("reports failure when the pointer did not end where the action put it", async () => {
    const mac = fakeMac({ cursorAfter: () => ({ x: 0, y: 0 }) });
    await expect(engineOn(mac).click({ x: 400, y: 220 }, { button: "left", count: 1, modifiers: [] })).rejects.toThrow(
      "The pointer is at (0, 0) after the action, not (400, 220); macOS dropped the input",
    );
  });

  it("scrolls by signed wheel ticks for each direction", async () => {
    const mac = fakeMac();
    const engine = engineOn(mac);
    await engine.scroll({ x: 50, y: 60 }, "down", 4);
    await engine.scroll({ x: 50, y: 60 }, "left", 2);
    const inputs = mac.calls.filter((call) => scriptName(call.args) === "pointer").map(scriptInput);
    expect(inputs).toEqual([
      { action: "scroll", x: 50, y: 60, dy: -1, dx: 0, ticks: 4 },
      { action: "scroll", x: 50, y: 60, dy: 0, dx: 1, ticks: 2 },
    ]);
  });

  it("refuses counts, repeats, and amounts outside their ranges", async () => {
    const engine = engineOn(fakeMac());
    await expect(engine.click({ x: 1, y: 1 }, { button: "left", count: 4, modifiers: [] })).rejects.toThrow("Expected click count 1 to 3, got 4");
    await expect(engine.key("a", 0)).rejects.toThrow("Expected key repeat 1 to 20, got 0");
    await expect(engine.scroll({ x: 1, y: 1 }, "up", 21)).rejects.toThrow("Expected scroll amount 1 to 20, got 21");
    await expect(engine.uiSnapshot(42, 401)).rejects.toThrow("Expected max elements 1 to 400, got 401");
  });

  it("presses a parsed key combination the given number of times", async () => {
    const mac = fakeMac();
    await engineOn(mac).key("cmd+shift+t", 3);
    const keyboard = mac.calls.find((call) => scriptName(call.args) === "keyboard");
    expect(scriptInput(keyboard!)).toEqual({ kind: "key", code: 17, flags: 0x100000 | 0x20000, repeat: 3 });
  });
});

describe("capturing the screen", () => {
  it("captures the main display without sound and scales it to point size, then deletes the files", async () => {
    const mac = fakeMac();
    const scratchDir = tempDir("computerise-shot-");
    const shot = await new MacEngine({ run: mac.run, scratchDir }).screenshot();
    expect(shot).toEqual({ jpeg: Buffer.from("small-jpeg"), width: 1512, height: 982 });
    const capture = mac.calls.find((call) => call.file === "screencapture")!;
    const sips = mac.calls.find((call) => call.file === "sips")!;
    const raw = capture.args[capture.args.length - 1];
    expect(capture.args).toEqual(["-x", "-m", "-t", "jpg", raw]);
    expect(sips.args).toEqual(["--resampleWidth", "1512", "-s", "formatOptions", "70", raw, "--out", sips.args[7]]);
    expect(existsSync(raw)).toBe(false);
    expect(existsSync(sips.args[7])).toBe(false);
  });

  it("zooms into an integer region on the display at full pixel resolution", async () => {
    const mac = fakeMac();
    const engine = engineOn(mac);
    const shot = await engine.zoom([100, 100, 300, 200]);
    expect(shot).toEqual({ jpeg: Buffer.from("raw-jpeg"), width: 400, height: 200 });
    const capture = mac.calls.find((call) => call.file === "screencapture")!;
    expect(capture.args.slice(0, 4)).toEqual(["-x", "-R", "100,100,200,100", "-t"]);
    expect(mac.calls.some((call) => call.file === "sips")).toBe(false);
    await expect(engine.zoom([300, 100, 100, 200])).rejects.toThrow("Expected a region [x0, y0, x1, y1] with x0 < x1 and y0 < y1");
    await expect(engine.zoom([0, 0, 1513, 10])).rejects.toThrow("outside the main display");
    await expect(engine.zoom([0.5, 0, 10, 10])).rejects.toThrow("Expected whole-point region coordinates");
  });

  it("shows only one app's windows, at their screen positions, when given its process id", async () => {
    const mac = fakeMac();
    const engine = engineOn(mac);
    const shot = await engine.screenshot(42);
    expect(shot).toEqual({ jpeg: Buffer.from("composed-jpeg"), width: 1512, height: 982 });
    const composed = mac.calls.filter((call) => call.file === "osascript" && scriptName(call.args) === "compose").map(scriptInput);
    expect(composed).toEqual([{ pid: 42, region: [0, 0, 1512, 982], scale: 1, out: expect.any(String) }]);
    expect(existsSync(composed[0].out as string)).toBe(false);
    expect(mac.calls.some((call) => call.file === "screencapture" || call.file === "sips")).toBe(false);

    const zoomed = await engine.zoom([100, 100, 300, 200], 42);
    expect(zoomed).toEqual({ jpeg: Buffer.from("composed-jpeg"), width: 400, height: 200 });
    expect(scriptInput(mac.calls.filter((call) => call.file === "osascript" && scriptName(call.args) === "compose")[1])).toMatchObject({ pid: 42, region: [100, 100, 300, 200], scale: 2 });
  });

  it("never falls back to the full display when one app's windows cannot be drawn", async () => {
    const blank = engineOn(fakeMac({ composed: { drawn: 0, windows: 2 } }));
    await expect(blank.screenshot(42)).rejects.toThrow("Paseo needs Screen Recording");
    expect(blank.screenRecording()).toBe("missing");
    const windowless = fakeMac({ composed: { drawn: 0, windows: 0 } });
    await expect(engineOn(windowless).screenshot(42)).rejects.toThrow("The front app has no windows on screen to show");
    expect(windowless.calls.some((call) => call.file === "screencapture")).toBe(false);
  });

  it("remembers whether the last capture showed Screen Recording granted or missing", async () => {
    const mac = fakeMac();
    const engine = engineOn(mac);
    expect(engine.screenRecording()).toBe("unknown");
    await engine.screenshot();
    expect(engine.screenRecording()).toBe("granted");
    const denied = new MacEngine({
      run: async (file, args, timeoutMs) => {
        if (file === "screencapture") throw Object.assign(new Error("failed"), { stderr: "could not create image from display" });
        return mac.run(file, args, timeoutMs);
      },
      scratchDir: tempDir("computerise-deny-"),
    });
    await expect(denied.screenshot()).rejects.toThrow("Paseo needs Screen Recording");
    expect(denied.screenRecording()).toBe("missing");
  });

  it("names the Screen Recording permission when macOS refuses the capture", async () => {
    const run: RunFile = async (file, args) => {
      if (file === "screencapture") throw Object.assign(new Error("Command failed"), { stderr: "could not create image from display\n" });
      return fakeMac().run(file, args, 0);
    };
    await expect(new MacEngine({ run, scratchDir: tempDir("computerise-deny-") }).screenshot()).rejects.toThrow("Paseo needs Screen Recording");
  });
});

describe("script output", () => {
  it("names the script when it prints something that is not the expected JSON", async () => {
    const run: RunFile = async () => "execution error: oops";
    await expect(new MacEngine({ run, scratchDir: tempDir("computerise-bad-") }).status()).rejects.toThrow('The status script printed "execution error: oops", not JSON');
  });
});

describe.runIf(process.platform === "darwin")("the JXA scripts", () => {
  it.each(Object.keys(SCRIPTS) as ScriptName[])("%s compiles", async (name) => {
    const out = join(tempDir("computerise-osa-"), `${name}.scpt`);
    await promisify(execFile)("osacompile", ["-l", "JavaScript", "-e", SCRIPTS[name], "-o", out]);
    expect(existsSync(out)).toBe(true);
  });
});
