import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { MacEngine, runFile } from "./engine";
import { SCRIPTS } from "./engine-scripts";
import { ScriptHost } from "./script-host";
import { tempDir } from "./test-temp-dir";

// Runs against the real Mac with `npm run test:live`: it switches the front app to TextEdit and
// back, and posts one pointer move to where the pointer already is. Needs Accessibility and Screen
// Recording for the terminal or app running it.
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

describe.runIf(process.env.COMPUTERISE_LIVE === "1")("the engine on this Mac", () => {
  afterAll(() => host.close());

  it("sees the front app change between calls to the same long-lived host", async () => {
    const before = (await engine.status()).front?.bundleId;
    expect(before).toBeTruthy();
    await bringForward("com.apple.TextEdit");
    expect((await engine.status()).front?.bundleId).toBe(await freshFront());
    expect(await freshFront(), "TextEdit did not come forward; was someone using the Mac?").toBe("com.apple.TextEdit");
    await bringForward(before as string);
    expect((await engine.status()).front?.bundleId).toBe(await freshFront());
  });

  it("captures only the front app's windows at display size", async () => {
    const before = (await engine.status()).front?.bundleId as string;
    await bringForward("com.apple.TextEdit");
    const { front, display } = await engine.status();
    const shot = await engine.screenshot(front?.pid as number);
    await bringForward(before);
    expect(shot.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect({ width: shot.width, height: shot.height }).toEqual({ width: display.width, height: display.height });
    expect(engine.screenRecording()).toBe("granted");
  });

  it("posts pointer input through the host", async () => {
    const { cursor } = await engine.status();
    const target = { x: Math.round(cursor.x), y: Math.round(cursor.y) };
    await engine.move(target);
    expect((await engine.status()).cursor).toEqual(target);
  });
});
