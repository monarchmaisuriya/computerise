import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApprovalRow, type Mode, settingsSchema } from "../shared/contracts";
import { Approvals, ApprovalScopes } from "./approvals";
import { AuditLog } from "./audit";
import { ElementTables } from "./elements";
import { ComputerMcp, mcpServerEntry, SERVER_NAME, TOOL_NAMES } from "./mcp";
import { PanelState } from "./panel-state";
import { ControlStore, Failsafe, Lease, RateLimiter } from "./policy";
import { Seats } from "./seats";
import { fakeEngine, NOTES, ONE_PASSWORD, owner, PASEO, TEXTEDIT } from "./test-engine";
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
  wait: { seconds: 0.1 },
  cursor_position: {},
  status: {},
};

// status reports plugin state, so it answers while computer use is off or stopped.
const SCREEN_TOOLS = Object.keys(TOOL_ARGS).filter((tool) => tool !== "status");

const READ_ONLY_TOOLS = ["cursor_position", "screenshot", "status", "ui_snapshot", "wait", "zoom"];

describe("the computer MCP endpoint", () => {
  let mac: ReturnType<typeof fakeEngine>;
  let tokens: TokenAuthority;
  let seats: Seats;
  let control: ControlStore;
  let approvals: Approvals;
  let scopes: ApprovalScopes;
  let lease: Lease;
  let rows: { agentId: string; row: ApprovalRow }[];
  let auditPath: string;
  let computer: ComputerMcp;
  let panel: PanelState;
  let calls: RateLimiter;
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
    scopes = new ApprovalScopes();
    lease = new Lease(120_000);
    auditPath = join(root, "audit.jsonl");
    panel = new PanelState();
    calls = new RateLimiter(120, 60_000);
    currentSettings = settingsSchema.parse({});
    computer = new ComputerMcp({
      engine: mac.engine,
      tokens,
      seats,
      control,
      lease,
      calls,
      rates: new RateLimiter(60, 60_000),
      failsafe: new Failsafe(),
      approvals,
      scopes,
      elements: new ElementTables(),
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

  it("offers exactly the computer tools, marking the ones that change nothing as read-only", async () => {
    const client = await agent("agent-x", "auto");
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(Object.keys(TOOL_ARGS).sort());
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name).sort()).toEqual(READ_ONLY_TOOLS);
    for (const tool of tools) expect(tool.title).toBeTruthy();
    expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: PLUGIN_VERSION });
  });

  // Anthropic's API, and so every client that forwards to it, rejects tool schemas that are not
  // valid JSON Schema draft 2020-12, whatever "$schema" they declare.
  it("describes every tool input with a valid JSON Schema draft 2020-12", async () => {
    const client = await agent("agent-x", "auto");
    const validator = new Ajv2020({ strict: false });
    const invalid = (await client.listTools()).tools.flatMap((tool) => {
      const { $schema: _declared, ...schema } = tool.inputSchema as Record<string, unknown>;
      return validator.validateSchema(schema) ? [] : [`${tool.name}: ${validator.errorsText(validator.errors)}`];
    });
    expect(invalid).toEqual([]);
  });

  it("waits without touching the Mac", async () => {
    const client = await agent("agent-x", "auto");
    const started = Date.now();
    expect(await call(client, "wait", { seconds: 0.2 })).toMatchObject({ isError: false, text: "Waited 0.2 seconds" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(mac.calls).toEqual([]);
  });

  it("reports the pointer position and front app without acting", async () => {
    const client = await agent("agent-x", "auto");
    expect(await call(client, "cursor_position")).toMatchObject({ isError: false, text: "Pointer at (500, 500); front app: TextEdit (com.apple.TextEdit)" });
    expect(mac.effects()).toEqual([]);
  });

  it("returns a screenshot taken after an action when asked", async () => {
    const client = await agent("agent-x", "auto");
    await call(client, "screenshot");
    const result = await call(client, "click", { x: 400, y: 220, screenshot: true });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Done: click left at (400, 220) on TextEdit");
    expect(result.content.filter((part) => part.type === "image")).toHaveLength(1);
    expect(mac.effects().map((effect) => effect.method)).toEqual(["screenshot", "uiSnapshot", "click", "uiSnapshot", "screenshot"]);
    const audited = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(audited.map((entry) => [entry.tool, entry.outcome])).toEqual([["screenshot", "ok"], ["click", "ok"], ["ui_snapshot", "ok"], ["screenshot", "ok"]]);
    expect(panel.snapshot().recent.map((entry) => entry.tool)).toEqual(["screenshot", "ui_snapshot", "click", "screenshot"]);
  });

  it("reports the action as done but sends no image when a blocked app is in front afterwards", async () => {
    const client = await agent("agent-x", "auto");
    await call(client, "screenshot");
    const click = mac.engine.click;
    mac.engine.click = async (...args) => {
      await click(...args);
      mac.screen.front = ONE_PASSWORD;
    };
    const result = await call(client, "click", { x: 400, y: 220, screenshot: true });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Done: click left at (400, 220) on TextEdit");
    expect(result.text).toContain("No screenshot: 1Password (com.1password.1password) is blocked from view");
    expect(result.content.filter((part) => part.type === "image")).toHaveLength(0);
  });

  it.each(SCREEN_TOOLS)("%s does nothing on the Mac while the agent's mode is off", async (tool) => {
    const client = await agent("agent-x", "off");
    const result = await call(client, tool);
    expect(result).toMatchObject({ isError: true, text: "Computer use is off for this agent; the user can turn it on with /computer ask" });
    expect(mac.calls).toEqual([]);
  });

  it.each(SCREEN_TOOLS)("%s does nothing on the Mac while computer use is stopped", async (tool) => {
    const client = await agent("agent-x", "auto");
    await control.setStopped(true);
    const result = await call(client, tool);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Computer use is stopped by the user");
    expect(mac.calls).toEqual([]);
  });

  describe("the status tool", () => {
    it("tells an agent whose mode is off how the user turns it on, reading only the status script", async () => {
      const client = await agent("agent-x", "off");
      const result = await call(client, "status");
      expect(result).toMatchObject({ isError: false });
      expect(result.text).toBe(
        [
          "Mode: off; the user can turn it on with /computer ask or /computer auto",
          "Not stopped",
          "Screen: free",
          "Accessibility: granted",
          "Screen Recording: not checked yet; the user can check it in the Computer panel",
          "Working app: none; take a screenshot or ui_snapshot first",
          "Element numbers: none; call ui_snapshot",
        ].join("\n"),
      );
      expect(mac.calls.map((entry) => entry.method)).toEqual(["status"]);
    });

    it("reports a stop, another agent holding the screen, and missing permissions", async () => {
      const other = await agent("agent-y", "auto");
      await call(other, "screenshot");
      const client = await agent("agent-x", "ask");
      await control.setStopped(true);
      mac.screen.trusted = false;
      mac.screen.screenRecording = "missing";
      const text = (await call(client, "status")).text;
      expect(text).toContain("Mode: ask (the user approves each input action)");
      expect(text).toContain("Stopped by the user; they can resume it from the Computer panel");
      expect(text).toContain("Screen: held by agent title of agent-y");
      expect(text).toContain("Accessibility: missing; the user grants it to Paseo in System Settings > Privacy & Security > Accessibility, or from the Computer panel");
      expect(text).toContain("Screen Recording: missing; the user grants it to Paseo in System Settings > Privacy & Security > Screen Recording, then reopens Paseo");
    });

    it("names the agent's working app and element numbers once it has them", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "ui_snapshot");
      const text = (await call(client, "status")).text;
      expect(text).toContain("Screen: held by you");
      expect(text).toContain("Working app: TextEdit (com.apple.TextEdit)");
      expect(text).toContain("Element numbers: 1 controls from TextEdit");
    });

    it("still needs a bound seat and counts toward the call limit", async () => {
      const unbound = await connect(`Bearer ${tokens.mint({ seat: seats.mint() })}`);
      expect(await call(unbound, "status")).toMatchObject({ isError: true, text: "Computer use is not ready for this agent yet; try again in a moment" });
      const client = await agent("agent-x", "off");
      const take = vi.spyOn(calls, "take");
      await call(client, "status");
      expect(take).toHaveBeenCalledWith("agent-x");
    });
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
    expect(mac.effects().map((effect) => effect.method)).toEqual(["screenshot", "uiSnapshot", "type", "uiSnapshot"]);
    expect(mac.calls.find((effect) => effect.method === "type")?.args).toEqual(["hunter2!", "com.apple.TextEdit"]);
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

  it("captures only the front app's windows when the user chose that scope", async () => {
    const client = await agent("agent-x", "auto");
    await call(client, "screenshot");
    await call(client, "zoom");
    currentSettings = { ...currentSettings, screenshotScope: "front-app" };
    await call(client, "screenshot");
    await call(client, "zoom");
    expect(mac.effects().map((effect) => [effect.method, effect.args.at(-1)])).toEqual([
      ["screenshot", null],
      ["zoom", null],
      ["screenshot", 42],
      ["zoom", 42],
    ]);
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
      ["uiSnapshot", TEXTEDIT.pid],
      ["openApp", "com.apple.Notes"],
      ["uiSnapshot", TEXTEDIT.pid],
      ["activate", "com.apple.Notes"],
      ["uiSnapshot", NOTES.pid],
      ["key", "cmd+s"],
      ["uiSnapshot", NOTES.pid],
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
      ["screenshot", null],
      ["activate", "com.apple.TextEdit"],
      ["uiSnapshot", TEXTEDIT.pid],
      ["type", "hello"],
      ["uiSnapshot", TEXTEDIT.pid],
    ]);
  });

  it("in ask mode, allowing an app for the turn skips the prompt for later pointer actions there only", async () => {
    const client = await agent("agent-x", "ask");
    await call(client, "screenshot");
    const first = call(client, "click", { x: 400, y: 220 });
    const row = await nextRow(1);
    expect(row.row.appScope).toBe("TextEdit");
    approvals.answer(row.row.requestId, "agent-x", true, "app-for-turn");
    expect((await first).isError).toBe(false);

    expect((await call(client, "scroll", { x: 400, y: 220, direction: "down" })).isError).toBe(false);
    expect((await call(client, "move", { x: 410, y: 230 })).isError).toBe(false);
    expect(rows.filter((shown) => shown.row.status === "pending")).toHaveLength(1);

    const typing = call(client, "type", { text: "hi" });
    const typingRow = await nextRow(2);
    expect(typingRow.row.appScope).toBeNull();
    approvals.answer(typingRow.row.requestId, "agent-x", false);
    expect((await typing).text).toContain("The user denied this action");

    mac.screen.under = owner(NOTES);
    const other = call(client, "click", { x: 400, y: 220 });
    const otherRow = await nextRow(3);
    approvals.answer(otherRow.row.requestId, "agent-x", false);
    expect((await other).isError).toBe(true);
    expect(mac.effects().map((effect) => effect.method).filter((method) => method !== "uiSnapshot")).toEqual(["screenshot", "click", "scroll", "move"]);
  });

  it("refuses an approved action when the agent lost the screen while waiting", async () => {
    const client = await agent("agent-x", "ask");
    await call(client, "screenshot");
    const pending = call(client, "click", { x: 400, y: 220 });
    const row = await nextRow(1);
    lease.release("agent-x");
    approvals.answer(row.row.requestId, "agent-x", true);
    expect((await pending).text).toContain("The screen was released while this action waited");
    expect(mac.effects().map((effect) => effect.method)).toEqual(["screenshot"]);
  });

  it("interrupts the running macOS step when the user stops computer use", async () => {
    await computer.stopAll();
    expect(mac.calls.map((entry) => entry.method)).toContain("interrupt");
  });

  it("tells the keyboard which app it checked, so keys stop if another app comes to the front", async () => {
    const client = await agent("agent-x", "auto");
    await call(client, "screenshot");
    await call(client, "type", { text: "hi" });
    await call(client, "key", { keys: "cmd+s" });
    expect(mac.effects().filter((effect) => effect.method === "type" || effect.method === "key").map((effect) => effect.args.at(-1))).toEqual(["com.apple.TextEdit", "com.apple.TextEdit"]);
  });

  // The state read after the action comes first: it catches the corner push and stops computer use,
  // so the screenshot is then refused as stopped.
  it.each([
    ["the agent is turned off", async () => control.setMode("agent-x", "off"), "Computer use is off for this agent", "Computer use is off for this agent"],
    ["the user stops computer use", async () => computer.stopAll(), "Computer use is stopped by the user", "Computer use is stopped by the user"],
    ["the user pushes the pointer into the corner", async () => void (mac.screen.cursor = { x: 0, y: 0 }), "The pointer is in the top-left corner", "Computer use is stopped by the user"],
  ])("sends no state or screenshot after an action when %s during it", async (_case, happen, stateReason, reason) => {
    const client = await agent("agent-x", "auto");
    await call(client, "screenshot");
    const click = mac.engine.click;
    mac.engine.click = async (...args) => {
      await click(...args);
      await happen();
    };
    const result = await call(client, "click", { x: 400, y: 220, screenshot: true });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Done: click left at (400, 220) on TextEdit");
    expect(result.text).toContain(`No state: ${stateReason}`);
    expect(result.text).toContain(`No screenshot: ${reason}`);
    expect(result.content.filter((part) => part.type === "image")).toHaveLength(0);
    expect(mac.effects().filter((effect) => effect.method === "screenshot")).toHaveLength(1);
  });

  it("forgets apps allowed for the turn when the user stops computer use", async () => {
    const client = await agent("agent-x", "ask");
    await call(client, "screenshot");
    const first = call(client, "click", { x: 400, y: 220 });
    approvals.answer((await nextRow(1)).row.requestId, "agent-x", true, "app-for-turn");
    await first;
    await computer.stopAll();
    await control.setStopped(false);
    await call(client, "screenshot");
    const again = call(client, "click", { x: 400, y: 220 });
    approvals.answer((await nextRow(2)).row.requestId, "agent-x", false);
    expect((await again).text).toContain("The user denied this action");
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
    expect((await stoppedWhileWaiting).text).toContain("The request was withdrawn before it was answered");
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

  describe("acting on a control by its ui_snapshot number", () => {
    const FIELD = { role: "AXTextField", label: "Name", value: "ab", frame: [10, 20, 300, 24] as [number, number, number, number] };
    const SAVE = { role: "AXButton", label: "Save", value: null, frame: [100, 200, 80, 30] as [number, number, number, number] };
    const DELETE = { ...SAVE, label: "Delete" };
    const methods = () => mac.effects().map((effect) => effect.method);

    beforeEach(() => {
      mac.screen.elements = [FIELD, SAVE];
    });

    it("clicks, moves to, and scrolls at the control's middle after re-reading the window", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "ui_snapshot");
      const done = async (args: Record<string, unknown>, tool = "click") => (await call(client, tool, args)).text.split("\n")[0];
      expect(await done({ element: 2 })).toBe('Done: click left on element 2 (AXButton "Save") at (140, 215) on TextEdit');
      expect(await done({ element: 1 }, "move")).toBe('Done: move the pointer to element 1 (AXTextField "Name") at (160, 32) over TextEdit');
      expect(await done({ element: 1, direction: "down" }, "scroll")).toBe('Done: scroll down 3 on element 1 (AXTextField "Name") at (160, 32) on TextEdit');
      expect(mac.effects().filter((effect) => effect.method !== "uiSnapshot").map((effect) => [effect.method, effect.args[0]])).toEqual([
        ["click", { x: 140, y: 215 }],
        ["move", { x: 160, y: 32 }],
        ["scroll", { x: 160, y: 32 }],
      ]);
      // One ui_snapshot, then per action one fresh read (also the before state) and one after it.
      expect(methods().filter((method) => method === "uiSnapshot")).toHaveLength(7);
    });

    it("refuses an element number before any ui_snapshot", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "screenshot");
      expect(await call(client, "click", { element: 1 })).toMatchObject({ isError: true, text: "No element numbers yet: call ui_snapshot first" });
      expect(methods()).toEqual(["screenshot"]);
    });

    it.each([
      ["both an element and a point", { element: 1, x: 5, y: 5 }],
      ["neither an element nor a full point", { x: 5 }],
    ])("refuses %s before asking or acting", async (_case, args) => {
      const client = await agent("agent-x", "ask");
      await call(client, "ui_snapshot");
      expect(await call(client, "click", args)).toMatchObject({ isError: true, text: "Give either element, or both x and y" });
      expect(rows).toEqual([]);
      expect(methods()).toEqual(["uiSnapshot"]);
    });

    it("refuses a control that changed since the ui_snapshot, posting nothing", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "ui_snapshot");
      mac.screen.elements = [FIELD, { ...SAVE, frame: [140, 200, 80, 30] }];
      const result = await call(client, "click", { element: 2 });
      expect(result).toMatchObject({ isError: true, text: 'Element 2 changed since your last ui_snapshot (was AXButton "Save", now AXButton "Save" at 140,200); call ui_snapshot again' });
      expect(methods()).not.toContain("click");
    });

    it("refuses a control another app's window covers", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "ui_snapshot");
      mac.screen.under = owner(NOTES);
      expect(await call(client, "click", { element: 2 })).toMatchObject({ isError: true, text: "Element 2 is not on TextEdit's window at (140, 215): Notes is there" });
      expect(methods()).not.toContain("click");
    });

    it("asks with the control's name, and compares the approved control even if a later ui_snapshot renumbered the window", async () => {
      const client = await agent("agent-x", "ask");
      await call(client, "ui_snapshot");
      const pending = call(client, "click", { element: 2 });
      const { row } = await nextRow(1);
      expect(row).toMatchObject({ action: 'click left on element 2 (AXButton "Save") at (140, 215) on TextEdit', app: "TextEdit" });
      mac.screen.elements = [FIELD, DELETE];
      await call(client, "ui_snapshot");
      approvals.answer(row.requestId, "agent-x", true);
      expect(await pending).toMatchObject({ isError: true, text: expect.stringContaining('Element 2 changed since your last ui_snapshot (was AXButton "Save", now AXButton "Delete"') });
      expect(methods()).not.toContain("click");
    });

    it("forgets element numbers when the user stops computer use", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "ui_snapshot");
      await computer.stopAll();
      await control.setStopped(false);
      await call(client, "screenshot");
      expect(await call(client, "click", { element: 2 })).toMatchObject({ isError: true, text: "No element numbers yet: call ui_snapshot first" });
    });
  });

  describe("reporting what each action changed", () => {
    const FIELD = { role: "AXTextField", label: "Name", value: "ab", frame: [10, 20, 300, 24] as [number, number, number, number] };
    const SAVE = { role: "AXButton", label: "Save", value: null, frame: [100, 200, 80, 30] as [number, number, number, number] };
    const DONE = { role: "AXButton", label: "Done", value: null, frame: [200, 200, 80, 30] as [number, number, number, number] };
    const snapshotPids = () => mac.calls.filter((entry) => entry.method === "uiSnapshot").map((entry) => entry.args[0]);

    beforeEach(() => {
      mac.screen.elements = [FIELD, SAVE];
    });

    it("says when the front window's controls did not change", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "screenshot");
      const result = await call(client, "click", { x: 400, y: 220 });
      expect(result).toMatchObject({ isError: false });
      expect(result.text).toBe(
        "Done: click left at (400, 220) on TextEdit\nNo change detected in TextEdit's controls. The action may have done nothing, or changed something the accessibility tree does not show; take a screenshot to check.",
      );
      expect(snapshotPids()).toEqual([42, 42]);
    });

    it("lists what changed, numbered so the next action can use the new numbers", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "screenshot");
      const click = mac.engine.click;
      mac.engine.click = async (...args) => {
        await click(...args);
        mac.screen.elements = [{ ...FIELD, value: "abc" }, DONE];
      };
      const result = await call(client, "click", { x: 400, y: 220 });
      expect(result.text).toContain('Changed in TextEdit (3 changes; 2 controls now):\n~ 1. AXTextField "Name" value "abc" (was "ab")\n+ 2. AXButton "Done"\n- AXButton "Save"');
      mac.engine.click = click;
      expect((await call(client, "click", { element: 2 })).text).toContain('Done: click left on element 2 (AXButton "Done") at (240, 215) on TextEdit');
    });

    it("names the new front app when the action brought one forward", async () => {
      const client = await agent("agent-x", "auto");
      mac.engine.openApp = async (bundleId) => {
        mac.calls.push({ method: "openApp", args: [bundleId] });
        mac.screen.front = NOTES;
        mac.screen.elements = [SAVE];
      };
      expect((await call(client, "open_app", { name: "Notes" })).text).toBe(
        "Done: open Notes (com.apple.Notes)\nFront app is now Notes (1 controls); element numbers now refer to its front window.",
      );
    });

    it("never reads a front app blocked from view before acting", async () => {
      const client = await agent("agent-x", "auto");
      mac.screen.front = ONE_PASSWORD;
      mac.engine.openApp = async (bundleId) => {
        mac.calls.push({ method: "openApp", args: [bundleId] });
        mac.screen.front = NOTES;
      };
      const result = await call(client, "open_app", { name: "Notes" });
      expect(result.text).toContain("Front app is now Notes");
      expect(snapshotPids()).toEqual([NOTES.pid]);
    });

    it("reports no state and forgets element numbers when a blocked app is in front after the action", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "ui_snapshot");
      const click = mac.engine.click;
      mac.engine.click = async (...args) => {
        await click(...args);
        mac.screen.front = ONE_PASSWORD;
      };
      const result = await call(client, "click", { x: 400, y: 220 });
      expect(result).toMatchObject({ isError: false, text: "Done: click left at (400, 220) on TextEdit\nNo state: 1Password (com.1password.1password) is blocked from view" });
      mac.engine.click = click;
      mac.screen.front = TEXTEDIT;
      expect((await call(client, "click", { element: 1 })).text).toBe("No element numbers yet: call ui_snapshot first");
    });

    it("keeps the app open_app opened as the working app while it is still launching", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "screenshot");
      mac.screen.activateBringsForward = false;
      expect((await call(client, "open_app", { name: "Notes" })).isError).toBe(false);
      expect(await call(client, "type", { text: "hi" })).toMatchObject({ isError: true, text: "Notes did not come to the front; take a new screenshot" });
      expect(mac.effects().filter((effect) => effect.method === "type")).toEqual([]);
    });

    it("reuses the element action's own fresh read as the before state", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "ui_snapshot");
      await call(client, "click", { element: 2 });
      expect(snapshotPids()).toEqual([42, 42, 42]);
    });

    it("never takes the screen back after an action when the agent let go of it during the action", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "screenshot");
      const click = mac.engine.click;
      mac.engine.click = async (...args) => {
        await click(...args);
        lease.release("agent-x");
      };
      const result = await call(client, "click", { x: 400, y: 220, screenshot: true });
      expect(result.text).toContain("No state: The screen was released after this action (for example, the agent's turn ended)");
      expect(result.text).toContain("No screenshot: The screen was released after this action (for example, the agent's turn ended)");
      expect(lease.holderId()).toBe(null);
      expect(mac.effects().map((effect) => effect.method)).toEqual(["screenshot", "uiSnapshot", "click"]);
    });

    it("audits the read after an action without charging it to the agent's call limit", async () => {
      const client = await agent("agent-x", "auto");
      await call(client, "screenshot");
      const take = vi.spyOn(calls, "take");
      await call(client, "click", { x: 400, y: 220 });
      expect(take).toHaveBeenCalledTimes(1);
      const audited = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(audited.map((entry) => [entry.tool, entry.outcome])).toEqual([["screenshot", "ok"], ["click", "ok"], ["ui_snapshot", "ok"]]);
    });
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
