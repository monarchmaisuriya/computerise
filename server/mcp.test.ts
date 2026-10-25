import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApprovalRow, type Mode, settingsSchema } from "../shared/contracts";
import { Approvals } from "./approvals";
import { AuditLog } from "./audit";
import { ComputerMcp, mcpServerEntry, SERVER_NAME, TOOL_NAMES } from "./mcp";
import { PanelState } from "./panel-state";
import { ControlStore, Failsafe, Lease, RateLimiter } from "./policy";
import { Seats } from "./seats";
import { fakeEngine, NOTES, ONE_PASSWORD, owner, PASEO } from "./test-engine";
import { tempDir } from "./test-temp-dir";
import { TokenAuthority } from "./tokens";
import { PLUGIN_VERSION } from "./version";

const TOOL_ARGS: Record<string, Record<string, unknown>> = {
  screenshot: {},
  zoom: { region: [0, 0, 100, 100] },
  ui_snapshot: {},
  click: { x: 400, y: 220 },
  move: { x: 400, y: 220 },
  drag: { from: [10, 10], to: [20, 20] },
  scroll: { x: 400, y: 220, direction: "down" },
  type: { text: "hello" },
  key: { keys: "cmd+s" },
  open_app: { name: "Notes" },
};

describe("the computer MCP endpoint", () => {
  let mac: ReturnType<typeof fakeEngine>;
  let tokens: TokenAuthority;
  let seats: Seats;
  let control: ControlStore;
  let approvals: Approvals;
  let rows: { agentId: string; row: ApprovalRow }[];
  let auditPath: string;
  let computer: ComputerMcp;
  let panel: PanelState;
  let currentSettings: ReturnType<typeof settingsSchema.parse>;
  let http: Server;
  let port: number;
  let clients: Client[];

  beforeEach(async () => {
    const root = tempDir("computerise-mcp-");
    mac = fakeEngine();
    tokens = new TokenAuthority(randomBytes(32));
    seats = await Seats.open(join(root, "seats.json"));
    control = await ControlStore.open(join(root, "control.json"));
    rows = [];
    approvals = new Approvals({ show: async (agentId, _rowId, row) => void rows.push({ agentId, row }) }, async () => 2_000);
    auditPath = join(root, "audit.jsonl");
    panel = new PanelState();
    currentSettings = settingsSchema.parse({});
    computer = new ComputerMcp({
      engine: mac.engine,
      tokens,
      seats,
      control,
      lease: new Lease(120_000),
      calls: new RateLimiter(120, 60_000),
      rates: new RateLimiter(60, 60_000),
      failsafe: new Failsafe(),
      approvals,
      audit: new AuditLog(auditPath),
      panel,
      settings: async () => currentSettings,
      agentTitle: async (agentId) => `title of ${agentId}`,
    });
    http = await computer.listen(0);
    port = (http.address() as AddressInfo).port;
    clients = [];
  });
  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await new Promise((resolve) => http.close(resolve));
  });

  async function agent(agentId: string, mode: Mode): Promise<Client> {
    const seat = seats.mint();
    await seats.bind(seat, agentId);
    await control.setMode(agentId, mode);
    return connect(`Bearer ${tokens.mint({ seat })}`);
  }

  async function connect(authorization: string): Promise<Client> {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpServerEntry(port, "unused")[SERVER_NAME].url), { requestInit: { headers: { Authorization: authorization } } }));
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = TOOL_ARGS[name]) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    return { text: content.flatMap((part) => (part.text ? [part.text] : [])).join("\n"), content, isError: result.isError === true };
  }

  // The count-th pending row; later status updates of a row are pushed to rows too.
  async function nextRow(count: number): Promise<{ agentId: string; row: ApprovalRow }> {
    const pending = () => rows.filter((shown) => shown.row.status === "pending");
    for (let i = 0; i < 200 && pending().length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pending().length).toBe(count);
    return pending()[count - 1];
  }

  it("refuses connections without a valid token", async () => {
    await expect(connect("Bearer nope.nope")).rejects.toThrow(/401|not valid/);
    await expect(connect(`Bearer ${new TokenAuthority(randomBytes(32)).mint({ seat: "s" })}`)).rejects.toThrow(/401|not valid/);
  });

  it("offers exactly the ten computer tools", async () => {
    const client = await agent("agent-x", "auto");
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(Object.keys(TOOL_ARGS).sort());
    expect(names).toEqual([...TOOL_NAMES]);
    expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: PLUGIN_VERSION });
  });

  it.each(Object.keys(TOOL_ARGS))("%s does nothing on the Mac while the agent's mode is off", async (tool) => {
    const client = await agent("agent-x", "off");
    const result = await call(client, tool);
    expect(result).toMatchObject({ isError: true, text: "Computer use is off for this agent; the user can turn it on with /computer ask" });
    expect(mac.calls).toEqual([]);
  });

  it.each(Object.keys(TOOL_ARGS))("%s does nothing on the Mac while computer use is stopped", async (tool) => {
    const client = await agent("agent-x", "auto");
    await control.setStopped(true);
    const result = await call(client, tool);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Computer use is stopped by the user");
    expect(mac.calls).toEqual([]);
  });

  it("refuses a token whose seat is not bound to an agent yet", async () => {
    const client = await connect(`Bearer ${tokens.mint({ seat: seats.mint() })}`);
    const result = await call(client, "screenshot");
    expect(result).toMatchObject({ isError: true, text: "Computer use is not ready for this agent yet; try again in a moment" });
    expect(mac.calls).toEqual([]);
  });

  it("in auto mode types into the working app without asking, and audits the character count, not the text", async () => {
    const client = await agent("agent-x", "auto");
    const shot = await call(client, "screenshot");
    expect(shot.isError).toBe(false);
    expect(shot.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg", data: Buffer.from("jpeg").toString("base64") });
    expect(shot.text).toContain("front app: TextEdit (com.apple.TextEdit)");
    const typed = await call(client, "type", { text: "hunter2!" });
    expect(typed.isError).toBe(false);
    expect(mac.effects().map((effect) => effect.method)).toEqual(["screenshot", "type"]);
    expect(mac.calls.find((effect) => effect.method === "type")?.args).toEqual(["hunter2!"]);
    expect(rows).toEqual([]);
    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain('"chars":8');
    expect(audit).not.toContain("hunter2");
  });

  it("never writes typed text to audit or panel history when the engine error echoes it", async () => {
    const client = await agent("agent-x", "auto");
    await call(client, "screenshot");
    mac.engine.type = async (text) => {
      throw new Error(`keyboard command failed with ${text}`);
    };

    const result = await call(client, "type", { text: "super-secret-value" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("super-secret-value");
    expect(await readFile(auditPath, "utf8")).not.toContain("super-secret-value");
    expect(JSON.stringify(panel.snapshot())).not.toContain("super-secret-value");
    expect(panel.snapshot().recent[0]).toMatchObject({ tool: "type", outcome: "error", chars: 18 });
  });

  it("rate-limits read tools as well as actions", async () => {
    const client = await agent("agent-x", "auto");
    for (let i = 0; i < 120; i += 1) expect((await call(client, "screenshot")).isError).toBe(false);
    const refused = await call(client, "screenshot");
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Refused: 120 actions in the last minute");
  });

  it("refuses input until the agent has a working app", async () => {
    const client = await agent("agent-x", "auto");
    const result = await call(client, "type");
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain("Take a screenshot first");
    expect(mac.effects()).toEqual([]);
  });

  it("refuses another agent while one holds the screen, naming the holder", async () => {
    const first = await agent("agent-x", "auto");
    const second = await agent("agent-y", "auto");
    await call(first, "screenshot");
    const result = await call(second, "click");
    expect(result).toMatchObject({ isError: true, text: "Agent title of agent-x is using the screen" });
    expect(mac.effects().map((effect) => effect.method)).toEqual(["screenshot"]);
  });

  it("refuses a click on a blocked app's window and a screenshot of a password manager", async () => {
    const client = await agent("agent-x", "auto");
    await call(client, "screenshot");
    mac.screen.under = owner(PASEO);
    const click = await call(client, "click");
    expect(click.isError).toBe(true);
    expect(click.text).toContain("Paseo (sh.paseo.desktop) is blocked for input");
    mac.screen.under = null;
    expect((await call(client, "click")).text).toContain("No window is under (400, 220)");
    mac.screen.front = ONE_PASSWORD;
    const shot = await call(client, "screenshot");
    expect(shot.isError).toBe(true);
    expect(shot.text).toContain("1Password (com.1password.1password) is blocked from view");
    expect(mac.effects().map((effect) => effect.method)).toEqual(["screenshot"]);
  });

  it("drops a read result when a blocked app comes to the front during capture", async () => {
    const client = await agent("agent-x", "auto");
    mac.engine.screenshot = async () => {
      mac.calls.push({ method: "screenshot", args: [] });
      mac.screen.front = ONE_PASSWORD;
      return { jpeg: Buffer.from("private"), width: 1512, height: 982 };
    };

    const result = await call(client, "screenshot");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("1Password (com.1password.1password) is blocked from view");
    expect(result.content.some((part) => part.type === "image")).toBe(false);
    expect(panel.snapshot().screenshot).toBeNull();
  });

  it("refuses to open a blocked app and opens an allowed one as the new working app", async () => {
    const client = await agent("agent-x", "auto");
    expect((await call(client, "open_app", { name: "Paseo" })).text).toContain("blocked for input");
    expect((await call(client, "open_app", { name: "Nope" })).text).toContain('No app named "Nope"');
    expect((await call(client, "open_app", { name: "Notes" })).isError).toBe(false);
    await call(client, "key");
    expect(mac.effects().map((effect) => [effect.method, effect.args[0]])).toEqual([
      ["openApp", "com.apple.Notes"],
      ["activate", "com.apple.Notes"],
      ["key", "cmd+s"],
    ]);
  });

  it("in ask mode waits for Allow, then brings the working app back to the front before acting", async () => {
    const client = await agent("agent-x", "ask");
    await call(client, "screenshot");
    expect(rows).toEqual([]);
    const pending = call(client, "type", { text: "hello" });
    const { agentId, row } = await nextRow(1);
    expect(agentId).toBe("agent-x");
    expect(row).toMatchObject({ action: 'type "hello"', app: "TextEdit", status: "pending" });
    expect(mac.effects().map((effect) => effect.method)).toEqual(["screenshot"]);
    mac.screen.front = PASEO;
    approvals.answer(row.requestId, "agent-x", true);
    expect((await pending).isError).toBe(false);
    expect(mac.effects().map((effect) => [effect.method, effect.args[0]])).toEqual([
      ["screenshot", undefined],
      ["activate", "com.apple.TextEdit"],
      ["type", "hello"],
    ]);
  });

  it("in ask mode does nothing when the user denies or does not answer", async () => {
    const client = await agent("agent-x", "ask");
    await call(client, "screenshot");
    const denied = call(client, "click");
    approvals.answer((await nextRow(1)).row.requestId, "agent-x", false);
    expect((await denied).text).toContain("The user denied this action");
    const ignored = await call(client, "click");
    expect(ignored.text).toContain("The user did not answer in time");
    expect(mac.effects().map((effect) => effect.method)).toEqual(["screenshot"]);
  });

  it("refuses an approved click when another app's window moved under the point while waiting", async () => {
    const client = await agent("agent-x", "ask");
    await call(client, "screenshot");
    const pending = call(client, "click");
    const { row } = await nextRow(1);
    expect(row.action).toBe("click left at (400, 220) on TextEdit");
    mac.screen.under = owner(NOTES);
    approvals.answer(row.requestId, "agent-x", true);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.text).toContain("The screen changed");
    expect(mac.effects().some((effect) => effect.method === "click")).toBe(false);
  });

  it("refuses approved typing when the working app does not come back to the front", async () => {
    const client = await agent("agent-x", "ask");
    await call(client, "screenshot");
    const pending = call(client, "type");
    const { row } = await nextRow(1);
    mac.screen.front = PASEO;
    mac.screen.activateBringsForward = false;
    approvals.answer(row.requestId, "agent-x", true);
    const result = await pending;
    expect(result.text).toContain("TextEdit did not come to the front");
    expect(mac.effects().some((effect) => effect.method === "type")).toBe(false);
  });

  it("refuses an approved action when the user turned the agent off or stopped everything while waiting", async () => {
    const client = await agent("agent-x", "ask");
    await call(client, "screenshot");
    const offWhileWaiting = call(client, "click");
    const first = await nextRow(1);
    await control.setMode("agent-x", "off");
    approvals.answer(first.row.requestId, "agent-x", true);
    expect((await offWhileWaiting).text).toContain("Computer use is off for this agent");
    await control.setMode("agent-x", "ask");
    const stoppedWhileWaiting = call(client, "click");
    await nextRow(2);
    await computer.stopAll();
    expect((await stoppedWhileWaiting).text).toContain("Computer use was stopped by the user");
    expect(rows.map((shown) => shown.row.status)).toEqual(["pending", "allowed", "pending", "cancelled"]);
    expect(mac.effects().map((effect) => effect.method)).toEqual(["screenshot"]);
  });

  it("rechecks stop, mode, and blocklist immediately before every automatic action", async () => {
    const client = await agent("agent-x", "auto");
    await call(client, "screenshot");

    await control.setStopped(true);
    expect((await call(client, "type", { text: "stopped" })).text).toContain("Computer use is stopped");
    await control.setStopped(false);

    await control.setMode("agent-x", "off");
    expect((await call(client, "type", { text: "off" })).text).toContain("Computer use is off");
    await control.setMode("agent-x", "auto");

    const originalWindowAt = mac.engine.windowAt;
    let reachedPlanning: (() => void) | undefined;
    const planning = new Promise<void>((resolve) => {
      reachedPlanning = resolve;
    });
    let continuePlanning: (() => void) | undefined;
    const continueAfterSettingsChange = new Promise<void>((resolve) => {
      continuePlanning = resolve;
    });
    mac.engine.windowAt = async (point) => {
      reachedPlanning?.();
      await continueAfterSettingsChange;
      return originalWindowAt(point);
    };
    const pending = call(client, "click");
    await planning;
    currentSettings = settingsSchema.parse({ extraNoInput: ["com.apple.TextEdit"] });
    continuePlanning?.();
    expect((await pending).text).toContain("TextEdit (com.apple.TextEdit) is blocked for input");
    expect(mac.effects().some((effect) => effect.method === "click")).toBe(false);
  });

  it("stops an action when the user moves the pointer to the corner during planning", async () => {
    const client = await agent("agent-x", "auto");
    await call(client, "screenshot");
    const originalWindowAt = mac.engine.windowAt;
    mac.engine.windowAt = async (point) => {
      mac.screen.cursor = { x: 0, y: 0 };
      return originalWindowAt(point);
    };

    const result = await call(client, "click");
    expect(result.text).toContain("pointer is in the top-left corner");
    expect(control.stopped()).toBe(true);
    expect(mac.effects().some((effect) => effect.method === "click")).toBe(false);
  });

  it("stops all computer use when the pointer is pushed into the top-left corner", async () => {
    const client = await agent("agent-x", "auto");
    mac.screen.cursor = { x: 0, y: 0 };
    const result = await call(client, "screenshot");
    expect(result.text).toContain("The pointer is in the top-left corner");
    expect(control.stopped()).toBe(true);
    expect(mac.effects()).toEqual([]);
  });

  it("does not count its own move to the corner as the user's", async () => {
    const client = await agent("agent-x", "auto");
    await call(client, "screenshot");
    expect((await call(client, "move", { x: 0, y: 0 })).isError).toBe(false);
    mac.screen.cursor = { x: 0, y: 0 };
    expect((await call(client, "screenshot")).isError).toBe(false);
    expect(control.stopped()).toBe(false);
  });

  it("lists the front window's controls as text for models without images", async () => {
    const client = await agent("agent-x", "auto");
    const result = await call(client, "ui_snapshot", { max_elements: 50 });
    expect(result.text).toContain('AXTextArea value="hello" at 10,20 300x400');
    expect(mac.calls.find((effect) => effect.method === "uiSnapshot")?.args).toEqual([42, 50]);
  });

  it("refuses arguments outside their schema before reaching the Mac", async () => {
    const client = await agent("agent-x", "auto");
    await call(client, "screenshot");
    expect((await call(client, "type", { text: "x".repeat(2001) })).isError).toBe(true);
    expect((await call(client, "click", { x: 1, y: 1, count: 9 })).isError).toBe(true);
    expect((await call(client, "key", { keys: "cmd+s", repeat: 0 })).isError).toBe(true);
    expect(mac.effects().map((effect) => effect.method)).toEqual(["screenshot"]);
  });
});
