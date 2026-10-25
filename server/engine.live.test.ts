import { execFile } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { center } from "./elements";
import { MacEngine, runFile } from "./engine";
import { SCRIPTS } from "./engine-scripts";
import { ScriptHost } from "./script-host";
import { tempDir } from "./test-temp-dir";

// Runs against the real Mac with `npm run test:live`: it switches the front app to TextEdit and
// back, clicks once into a scratch TextEdit document, and posts one pointer move to where the
// pointer already is. Needs Accessibility and Screen Recording for the terminal or app running it.
const host = new ScriptHost(SCRIPTS);
const engine = new MacEngine({ run: runFile, scripts: host, scratchDir: tempDir("computerise-live-") });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What a new osascript process sees: the reference the long-lived host must agree with.
async function freshFront(): Promise<string | null> {
  const { stdout } = await promisify(execFile)("osascript", ["-l", "JavaScript", "-e", SCRIPTS.status, "{}"]);
  return JSON.parse(stdout).front?.bundleId ?? null;
}

async function bringForward(bundleId: string): Promise<void> {
  await promisify(execFile)("open", ["-b", bundleId]);
  await sleep(1_500);
}

// Scratch documents are closed after each test. Left open they piled up across runs (27 windows on
// 2026-10-25), and the front-app capture, which captures every TextEdit window, ran past its timeout.
const opened: string[] = [];

async function openScratch(name: string, { background = false } = {}): Promise<void> {
  const document = join(tempDir("computerise-live-doc-"), name);
  await writeFile(document, `computerise live ${name}\n`);
  await promisify(execFile)("open", [...(background ? ["-g"] : []), "-b", "com.apple.TextEdit", document]);
  // TextEdit reports /private/var paths for the /var temporary folder.
  opened.push(await realpath(document));
  await sleep(1_500);
}

// Closes only documents at the paths this file opened, last first so closing does not shift the list.
const CLOSE_SCRATCH = `function run(argv) {
  var paths = JSON.parse(argv[0]);
  var documents = Application("TextEdit").documents();
  for (var i = documents.length - 1; i >= 0; i--) if (paths.indexOf(documents[i].path()) !== -1) documents[i].close({ saving: "no" });
}`;

describe.runIf(process.env.COMPUTERISE_LIVE === "1")("the engine on this Mac", () => {
  afterAll(() => host.close());
  afterEach(async () => {
    const paths = opened.splice(0);
    if (paths.length > 0) await promisify(execFile)("osascript", ["-l", "JavaScript", "-e", CLOSE_SCRATCH, JSON.stringify(paths)]);
  });

  it("sees the front app change between calls to the same long-lived host", async () => {
    const before = (await engine.status()).front?.bundleId;
    expect(before).toBeTruthy();
    await bringForward("com.apple.TextEdit");
    expect((await engine.status()).front?.bundleId).toBe(await freshFront());
    expect(await freshFront(), "TextEdit did not come forward; was someone using the Mac?").toBe("com.apple.TextEdit");
    await bringForward(before as string);
    expect((await engine.status()).front?.bundleId).toBe(await freshFront());
  });

  // Opens a document, not the bare app: capturing TextEdit while it is still opening its Open panel
  // blocked macOS's window capture for over 10 seconds (2026-10-25), which the plugin reports as a
  // failed call.
  it("captures only the front app's windows at display size", async () => {
    const before = (await engine.status()).front?.bundleId as string;
    await openScratch("capture-check.txt");
    const { front, display } = await engine.status();
    const shot = await engine.screenshot(front?.pid as number);
    await bringForward(before);
    expect(shot.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect({ width: shot.width, height: shot.height }).toEqual({ width: display.width, height: display.height });
    expect(engine.screenRecording()).toBe("granted");
  });

  it("refuses to type when the front app is not the one checked, before posting a key", async () => {
    await expect(engine.type("x", "com.example.not-in-front")).rejects.toThrow("is in front instead of com.example.not-in-front; typing stopped after 0 of 1 characters");
  });

  // Element numbers are positions in this list, so a settled window must list its controls in the
  // same order after a pause, as between a ui_snapshot and an action. A window that just opened can
  // still add controls (TextEdit adds a group at the end), so the check starts once two reads in a
  // row agree. Opens the document in the background; the front app stays.
  it("numbers a settled window's controls the same way after a pause", async () => {
    await openScratch("numbering-check.txt", { background: true });
    for (const name of ["TextEdit", "Finder"]) {
      const { stdout } = await promisify(execFile)("pgrep", ["-x", name]);
      const pid = Number(stdout.trim().split("\n")[0]);
      const read = async () => JSON.stringify((await engine.uiSnapshot(pid, 200)).elements.map((element) => [element.role, element.label, element.frame]));
      let settled = await read();
      for (const deadline = Date.now() + 5_000; ; ) {
        await sleep(250);
        const next = await read();
        if (next === settled) break;
        if (Date.now() > deadline) throw new Error(`${name}'s window kept changing for 5 seconds`);
        settled = next;
      }
      expect(JSON.parse(settled).length, `${name} listed no controls`).toBeGreaterThan(0);
      await sleep(500);
      expect(await read(), `${name} numbered its controls differently`).toBe(settled);
    }
  });

  // Element actions click a control's middle from ui_snapshot, so its frames must be in the same
  // points as clicks. Clicks into a scratch document, then restores the front app.
  it("places a click on a control's middle as listed by ui_snapshot", async () => {
    const before = (await engine.status()).front?.bundleId as string;
    await openScratch("element-check.txt");
    const { front } = await engine.status();
    expect(front?.bundleId, "TextEdit did not come forward; was someone using the Mac?").toBe("com.apple.TextEdit");
    const { elements } = await engine.uiSnapshot(front?.pid as number, 200);
    const inWindow = elements.filter((element) => element.frame && element.role !== "AXMenuBarItem" && element.frame[2] > 0 && element.frame[3] > 0);
    const owners = await Promise.all(inWindow.map(async (element) => (await engine.windowAt(center(element.frame as [number, number, number, number])))?.bundleId));
    const text = inWindow.find((element) => element.role === "AXTextArea");
    const point = center(text?.frame as [number, number, number, number]);
    await engine.click(point, { button: "left", count: 1, modifiers: [] });
    const after = await engine.status();
    await bringForward(before);
    expect(owners.length).toBeGreaterThan(0);
    expect(new Set(owners)).toEqual(new Set(["com.apple.TextEdit"]));
    expect(after.cursor).toEqual(point);
    expect(after.front?.bundleId).toBe("com.apple.TextEdit");
  });

  // Runs where both permissions are granted, so macOS shows no prompt; the prompt itself appears only
  // for an app that is not yet trusted.
  it("checks Screen Recording and Accessibility without an agent's screenshot", async () => {
    const checker = new MacEngine({ run: runFile, scripts: host, scratchDir: tempDir("computerise-live-check-") });
    expect(checker.screenRecording()).toBe("unknown");
    expect(await checker.checkScreenRecording()).toBe("granted");
    expect(await checker.promptAccessibility()).toBe(true);
  });

  it("posts pointer input through the host", async () => {
    const { cursor } = await engine.status();
    const target = { x: Math.round(cursor.x), y: Math.round(cursor.y) };
    await engine.move(target);
    expect((await engine.status()).cursor).toEqual(target);
  });
});
