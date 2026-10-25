import type { WindowOwner } from "./engine";
import type { Engine } from "./mcp";

export const TEXTEDIT = { name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 42 };
export const NOTES = { name: "Notes", bundleId: "com.apple.Notes", pid: 43 };
export const PASEO = { name: "Paseo", bundleId: "sh.paseo.desktop", pid: 44 };
export const ONE_PASSWORD = { name: "1Password", bundleId: "com.1password.1password", pid: 45 };

export function owner(app: { name: string; bundleId: string; pid: number }): WindowOwner {
  return { ...app, layer: 0 };
}

// Every Engine method records its call; status, windowAt, and activate read and change a small
// model of the screen that tests can edit while a call waits for approval.
export function fakeEngine() {
  const screen = {
    trusted: true,
    cursor: { x: 500, y: 500 },
    front: TEXTEDIT as { name: string; bundleId: string | null; pid: number } | null,
    under: owner(TEXTEDIT) as WindowOwner | null,
    activateBringsForward: true,
    screenRecording: "unknown" as "unknown" | "granted" | "missing",
    statusError: null as string | null,
  };
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string) => async (...args: unknown[]) => void calls.push({ method, args });
  const engine: Engine = {
    status: async () => {
      calls.push({ method: "status", args: [] });
      if (screen.statusError) throw new Error(screen.statusError);
      return { trusted: screen.trusted, cursor: screen.cursor, front: screen.front, display: { width: 1512, height: 982, scale: 2 } };
    },
    windowAt: async (point) => {
      calls.push({ method: "windowAt", args: [point] });
      return screen.under;
    },
    activate: async (bundleId) => {
      calls.push({ method: "activate", args: [bundleId] });
      const app = [TEXTEDIT, NOTES].find((candidate) => candidate.bundleId === bundleId);
      if (app && screen.activateBringsForward) screen.front = app;
      return { running: app !== undefined, activated: app !== undefined };
    },
    resolveApp: async (name) => {
      calls.push({ method: "resolveApp", args: [name] });
      const app = [TEXTEDIT, NOTES, PASEO].find((candidate) => candidate.name === name);
      return app ? { bundleId: app.bundleId, path: `/Applications/${name}.app` } : null;
    },
    click: record("click"),
    move: record("move"),
    drag: record("drag"),
    scroll: record("scroll"),
    type: record("type"),
    key: record("key"),
    openApp: record("openApp"),
    screenshot: async (onlyPid = null) => {
      calls.push({ method: "screenshot", args: [onlyPid] });
      return { jpeg: Buffer.from("jpeg"), width: 1512, height: 982 };
    },
    zoom: async (region, onlyPid = null) => {
      calls.push({ method: "zoom", args: [region, onlyPid] });
      return { jpeg: Buffer.from("zoomed"), width: 200, height: 200 };
    },
    screenRecording: () => screen.screenRecording,
    uiSnapshot: async (pid, max) => {
      calls.push({ method: "uiSnapshot", args: [pid, max] });
      return { elements: [{ role: "AXTextArea", label: null, value: "hello", frame: [10, 20, 300, 400] }], cut: false };
    },
  };
  return { engine, screen, calls, effects: () => calls.filter((call) => !["status", "windowAt", "resolveApp"].includes(call.method)) };
}
