import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Mode, Settings } from "../shared/contracts";
import type { Approvals } from "./approvals";
import type { AuditLog } from "./audit";
import { LIMITS, type MacEngine, type MouseButton, type Point, type ScreenStatus, type ScrollDirection } from "./engine";
import { type AppRef, blockLevel, type ControlStore, type Failsafe, type Lease, LeaseHeldError, type RateLimiter } from "./policy";
import type { Seats } from "./seats";
import type { TokenAuthority } from "./tokens";
import type { PanelState } from "./panel-state";
import { PLUGIN_VERSION } from "./version";

// Distinctive name: Paseo preapproves this server's tools by name, so a user's own server must not share it.
export const SERVER_NAME = "paseo-computerise";
export const TOOL_NAMES = ["click", "drag", "key", "move", "open_app", "screenshot", "scroll", "type", "ui_snapshot", "zoom"] as const;
const PATH = "/mcp";
const MAX_REQUEST_BYTES = 64 * 1024;
const FRONT_WAIT_MS = 1_000;
const FRONT_POLL_MS = 100;
const SHOWN_TEXT_CHARS = 300;

export const OFF_MESSAGE = "Computer use is off for this agent; the user can turn it on with /computer ask";
const NOT_READY = "Computer use is not ready for this agent yet; try again in a moment";
const STOPPED = "Computer use is stopped by the user; they can resume it from the Computer panel";

export type Engine = Pick<
  MacEngine,
  "status" | "windowAt" | "activate" | "resolveApp" | "openApp" | "click" | "move" | "drag" | "scroll" | "type" | "key" | "screenshot" | "zoom" | "uiSnapshot"
>;

export interface ComputerMcpOptions {
  engine: Engine;
  tokens: TokenAuthority;
  seats: Seats;
  control: ControlStore;
  lease: Lease;
  calls: RateLimiter;
  rates: RateLimiter;
  failsafe: Failsafe;
  approvals: Approvals;
  audit: AuditLog;
  panel?: PanelState;
  settings(): Promise<Settings>;
  agentTitle(agentId: string): Promise<string>;
}

export function mcpServerEntry(port: number, token: string) {
  return { [SERVER_NAME]: { type: "http" as const, url: `http://127.0.0.1:${port}${PATH}`, headers: { Authorization: `Bearer ${token}` } } };
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/jpeg" };

// An expected "no" reported to the agent, audited as refused rather than as an error.
class Refusal extends Error {}

type ReadSpec<A> = {
  kind: "read";
  run(agentId: string, args: A, status: ScreenStatus): Promise<{ content: Content[]; accepted?(): void }>;
};

// The receivers are the apps that get the input. They are read before approval ("planned") and
// again after the working app is back in front ("actual"); both must match and pass the blocklist.
type ActionSpec<A> = {
  kind: "action";
  needsWorkingApp: boolean;
  receivers(args: A, working: AppRef | null, phase: "planned" | "actual"): Promise<AppRef[]>;
  describe(args: A, receivers: AppRef[]): string;
  act(args: A, receivers: AppRef[]): Promise<void>;
  after?(agentId: string, args: A, receivers: AppRef[]): void;
  chars?(args: A): number;
};

type ToolSpec<A> = ReadSpec<A> | ActionSpec<A>;

function textContent(text: string): Content[] {
  return [{ type: "text", text }];
}

function at(point: Point): string {
  return `(${point.x}, ${point.y})`;
}

function appLabel(app: AppRef): string {
  return `${app.name} (${app.bundleId ?? "unknown app"})`;
}

function sameApps(a: AppRef[], b: AppRef[]): boolean {
  return a.length === b.length && a.every((app, i) => app.bundleId === b[i].bundleId);
}

function shownText(text: string): string {
  return text.length <= SHOWN_TEXT_CHARS ? JSON.stringify(text) : `${JSON.stringify(text.slice(0, SHOWN_TEXT_CHARS))}... (${text.length} characters)`;
}

const coordinate = z.number().describe("Main-display points, as read off the screenshot");
const pair = z.tuple([coordinate, coordinate]);

export class ComputerMcp {
  private executions: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ComputerMcpOptions) {}

  async stopAll(): Promise<void> {
    let persistenceError: unknown;
    await this.options.control.setStopped(true).catch((error: unknown) => {
      persistenceError = error;
    });
    this.options.approvals.cancelAll();
    this.options.lease.releaseAll();
    if (persistenceError) throw persistenceError;
  }

  private requireRunning(agentId: string): Mode {
    if (this.options.control.stopped()) throw new Refusal(STOPPED);
    const mode = this.options.control.mode(agentId);
    if (mode === "off") throw new Refusal(OFF_MESSAGE);
    return mode;
  }

  // One action at a time reaches the Mac, from bringing the app forward to the last event.
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.executions.then(run);
    this.executions = next.catch(() => undefined);
    return next;
  }

  private requireInputAllowed(apps: AppRef[], settings: Settings): void {
    for (const app of apps) if (blockLevel(app.bundleId, settings) !== "none") throw new Refusal(`${appLabel(app)} is blocked for input`);
  }

  private async appAt(point: Point): Promise<AppRef> {
    const owner = await this.options.engine.windowAt(point);
    if (owner === null) throw new Refusal(`No window is under ${at(point)}; take a new screenshot`);
    return { bundleId: owner.bundleId, name: owner.name };
  }

  // Approving in Paseo makes Paseo the front app, so the working app is brought back before acting.
  // Activation is not reliable, so the front app is read back rather than assumed.
  private async bringForward(app: AppRef): Promise<void> {
    const { engine } = this.options;
    if ((await engine.status()).front?.bundleId === app.bundleId) return;
    if (app.bundleId === null) throw new Refusal(`${app.name} cannot be brought to the front; use open_app`);
    if (!(await engine.activate(app.bundleId)).running) throw new Refusal(`${app.name} is no longer running; use open_app`);
    const deadline = Date.now() + FRONT_WAIT_MS;
    while (Date.now() < deadline) {
      if ((await engine.status()).front?.bundleId === app.bundleId) return;
      await new Promise((resolve) => setTimeout(resolve, FRONT_POLL_MS));
    }
    throw new Refusal(`${app.name} did not come to the front; take a new screenshot`);
  }

  private async read<A>(agentId: string, spec: ReadSpec<A>, args: A, status: ScreenStatus, settings: Settings) {
    const front = status.front;
    if (front && blockLevel(front.bundleId, settings) === "no-view") throw new Refusal(`${appLabel(front)} is blocked from view`);
    const result = await spec.run(agentId, args, status);
    const after = await this.options.engine.status();
    if (after.front && blockLevel(after.front.bundleId, settings) === "no-view") throw new Refusal(`${appLabel(after.front)} is blocked from view`);
    if (after.front?.pid !== front?.pid || after.front?.bundleId !== front?.bundleId) throw new Refusal("The screen changed while reading; try again");
    if (front) this.options.lease.setWorkingApp(agentId, { bundleId: front.bundleId, name: front.name });
    result.accepted?.();
    return { content: result.content, target: front?.bundleId ?? null };
  }

  private async act<A>(agentId: string, mode: Mode, spec: ActionSpec<A>, args: A, settings: Settings) {
    const { approvals, lease } = this.options;
    const working = lease.workingApp(agentId);
    if (spec.needsWorkingApp && working === null) throw new Refusal("Take a screenshot first, so the plugin knows which app you are working in");
    const planned = await spec.receivers(args, working, "planned");
    this.requireInputAllowed(planned, settings);
    const description = spec.describe(args, planned);
    if (mode === "ask") {
      const decision = await approvals.request(agentId, description, [...new Set(planned.map((app) => app.name))].join(", "));
      if (decision === "deny") throw new Refusal("The user denied this action");
      if (decision === "timeout") throw new Refusal("The user did not answer in time; nothing was done");
      if (decision === "cancelled") throw new Refusal("Computer use was stopped by the user");
      this.requireRunning(agentId);
    }
    return this.exclusive(async () => {
      if (spec.needsWorkingApp && working !== null) await this.bringForward(working);
      const actual = await spec.receivers(args, working, "actual");
      if (!sameApps(planned, actual)) throw new Refusal("The screen changed while waiting; take a new screenshot");
      const executionStatus = await this.options.engine.status();
      const executionSettings = await this.options.settings();
      this.requireRunning(agentId);
      if (this.options.failsafe.tripped(executionStatus.cursor)) {
        await this.stopAll();
        throw new Refusal("The pointer is in the top-left corner, so computer use is now stopped; the user can resume it from the Computer panel");
      }
      this.requireInputAllowed(actual, executionSettings);
      await spec.act(args, actual);
      spec.after?.(agentId, args, actual);
      return { content: textContent(`Done: ${description}`), target: actual.map((app) => app.bundleId).join(",") };
    });
  }

  // Every tool runs through here, in this order: identity, stop, mode, rate limit, corner failsafe,
  // lease, then the read or action path. Argument schemas are checked by the MCP server before.
  private async call<A>(seat: string, tool: string, spec: ToolSpec<A>, args: A) {
    const { engine, seats, calls, rates, failsafe, lease, audit } = this.options;
    let agentId: string | null = null;
    let target: string | null = null;
    const chars = spec.kind === "action" ? spec.chars?.(args) : undefined;
    try {
      agentId = seats.agentFor(seat);
      if (agentId === null) throw new Refusal(NOT_READY);
      const mode = this.requireRunning(agentId);
      calls.take(agentId);
      if (spec.kind === "action") rates.take(agentId);
      const status = await engine.status();
      if (failsafe.tripped(status.cursor)) {
        await this.stopAll();
        throw new Refusal("The pointer is in the top-left corner, so computer use is now stopped; the user can resume it from the Computer panel");
      }
      try {
        lease.take(agentId);
      } catch (error) {
        if (error instanceof LeaseHeldError) throw new Refusal(`Agent ${await this.options.agentTitle(error.holder)} is using the screen`);
        throw error;
      }
      const settings = await this.options.settings();
      const result = spec.kind === "read" ? await this.read(agentId, spec, args, status, settings) : await this.act(agentId, mode, spec, args, settings);
      target = result.target;
      await audit.record({ agentId, tool, target, outcome: "ok", chars });
      this.options.panel?.activity({ agentId, tool, target, outcome: "ok", chars });
      return { content: result.content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = error instanceof Refusal ? `refused: ${message}` : `error: ${message}`;
      const recordedOutcome = tool === "type" ? (error instanceof Refusal ? "refused" : "error") : outcome;
      await audit.record({ agentId, tool, target, outcome: recordedOutcome, chars }).catch((auditError: unknown) => console.error(`[computerise] audit write failed: ${String(auditError)}`));
      this.options.panel?.activity({ agentId, tool, target, outcome: recordedOutcome, chars });
      return { content: textContent(message), isError: true };
    }
  }

  private buildServer(seat: string): McpServer {
    const { engine, lease, failsafe } = this.options;
    const mcp = new McpServer({ name: SERVER_NAME, version: PLUGIN_VERSION });
    const register = <A>(name: (typeof TOOL_NAMES)[number], description: string, inputSchema: z.ZodRawShape, spec: ToolSpec<A>) => {
      mcp.registerTool(name, { description, inputSchema }, (args: unknown) => this.call(seat, name, spec, args as A));
    };
    const pointerAt = async (point: Point) => [await this.appAt(point)];
    // Keyboard input goes to the front app; before approval that is meant to be the working app.
    const keyboardReceivers = async (_args: unknown, working: AppRef | null, phase: "planned" | "actual"): Promise<AppRef[]> => {
      if (phase === "planned") return working ? [working] : [];
      const front = (await engine.status()).front;
      return front ? [{ bundleId: front.bundleId, name: front.name }] : [];
    };

    register("screenshot", "Capture the main display. The image is at point size: a coordinate read off it is the coordinate to click.", {}, {
      kind: "read",
      run: async (agentId, _args, status) => {
        const shot = await engine.screenshot();
        const front = status.front ? appLabel(status.front) : "none";
        return {
          content: [
            { type: "image", data: shot.jpeg.toString("base64"), mimeType: "image/jpeg" },
            { type: "text", text: `Main display, ${shot.width} x ${shot.height} points; front app: ${front}; pointer at ${at(status.cursor)}` },
          ],
          accepted: () => this.options.panel?.screenshot(agentId, shot.jpeg, shot.width, shot.height),
        };
      },
    });

    register<{ region: [number, number, number, number] }>(
      "zoom",
      "Capture a region of the main display at full pixel resolution, to read small text.",
      { region: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]).describe("[x0, y0, x1, y1] in points") },
      {
        kind: "read",
        run: async (_agentId, { region }) => {
          const shot = await engine.zoom(region);
          return {
            content: [
              { type: "image", data: shot.jpeg.toString("base64"), mimeType: "image/jpeg" },
              { type: "text", text: `Region [${region.join(", ")}], ${shot.width} x ${shot.height} pixels` },
            ],
          };
        },
      },
    );

    register<{ max_elements?: number }>(
      "ui_snapshot",
      "List the front window's controls as text (role, label, value, frame in points), for reading the screen without images.",
      { max_elements: z.number().int().min(1).max(LIMITS.snapshotElements).optional() },
      {
        kind: "read",
        run: async (_agentId, { max_elements }, status) => {
          if (!status.front) throw new Refusal("No app is in front");
          const snapshot = await engine.uiSnapshot(status.front.pid, max_elements ?? 200);
          const lines = snapshot.elements.map((element, i) => {
            const label = element.label ? ` ${JSON.stringify(element.label)}` : "";
            const value = element.value !== null ? ` value=${JSON.stringify(element.value)}` : "";
            const frame = element.frame ? ` at ${element.frame[0]},${element.frame[1]} ${element.frame[2]}x${element.frame[3]}` : "";
            return `${i + 1}. ${element.role ?? "unknown"}${label}${value}${frame}`;
          });
          const cut = snapshot.cut ? ", cut short" : "";
          return { content: textContent([`Front window of ${appLabel(status.front)} (${lines.length} elements${cut}):`, ...lines].join("\n")) };
        },
      },
    );

    register<{ x: number; y: number; button?: MouseButton; count?: number; modifiers?: string[] }>(
      "click",
      "Click at a point.",
      {
        x: coordinate,
        y: coordinate,
        button: z.enum(["left", "right", "middle"]).optional(),
        count: z.number().int().min(1).max(LIMITS.clickCount).optional().describe("2 for a double click"),
        modifiers: z.array(z.string().max(10)).max(4).optional().describe("cmd, shift, option, ctrl"),
      },
      {
        kind: "action",
        needsWorkingApp: true,
        receivers: ({ x, y }) => pointerAt({ x, y }),
        describe: ({ x, y, button = "left", count = 1, modifiers = [] }, [app]) =>
          `click ${button}${count > 1 ? ` x${count}` : ""}${modifiers.length ? ` with ${modifiers.join("+")}` : ""} at ${at({ x, y })} on ${app.name}`,
        act: ({ x, y, button = "left", count = 1, modifiers = [] }) => engine.click({ x, y }, { button, count, modifiers }),
        after: (_agentId, { x, y }) => failsafe.notePlaced({ x, y }),
      },
    );

    register<{ x: number; y: number }>("move", "Move the pointer to a point.", { x: coordinate, y: coordinate }, {
      kind: "action",
      needsWorkingApp: true,
      receivers: ({ x, y }) => pointerAt({ x, y }),
      describe: ({ x, y }, [app]) => `move the pointer to ${at({ x, y })} over ${app.name}`,
      act: ({ x, y }) => engine.move({ x, y }),
      after: (_agentId, { x, y }) => failsafe.notePlaced({ x, y }),
    });

    register<{ from: [number, number]; to: [number, number] }>("drag", "Press the left button at one point, move to another, and release.", { from: pair, to: pair }, {
      kind: "action",
      needsWorkingApp: true,
      receivers: async ({ from, to }) => [await this.appAt({ x: from[0], y: from[1] }), await this.appAt({ x: to[0], y: to[1] })],
      describe: ({ from, to }, [start, end]) => `drag from ${at({ x: from[0], y: from[1] })} on ${start.name} to ${at({ x: to[0], y: to[1] })} on ${end.name}`,
      act: ({ from, to }) => engine.drag({ x: from[0], y: from[1] }, { x: to[0], y: to[1] }),
      after: (_agentId, { to }) => failsafe.notePlaced({ x: to[0], y: to[1] }),
    });

    register<{ x: number; y: number; direction: ScrollDirection; amount?: number }>(
      "scroll",
      "Scroll at a point by lines.",
      { x: coordinate, y: coordinate, direction: z.enum(["up", "down", "left", "right"]), amount: z.number().int().min(1).max(LIMITS.scrollAmount).optional() },
      {
        kind: "action",
        needsWorkingApp: true,
        receivers: ({ x, y }) => pointerAt({ x, y }),
        describe: ({ x, y, direction, amount = 3 }, [app]) => `scroll ${direction} ${amount} at ${at({ x, y })} on ${app.name}`,
        act: ({ x, y, direction, amount = 3 }) => engine.scroll({ x, y }, direction, amount),
        after: (_agentId, { x, y }) => failsafe.notePlaced({ x, y }),
      },
    );

    register<{ text: string }>("type", "Type text into the app you are working in.", { text: z.string().min(1).max(LIMITS.typeUnits) }, {
      kind: "action",
      needsWorkingApp: true,
      receivers: keyboardReceivers,
      describe: ({ text }) => `type ${shownText(text)}`,
      act: ({ text }) => engine.type(text),
      chars: ({ text }) => text.length,
    });

    register<{ keys: string; repeat?: number }>(
      "key",
      "Press a key combination in the app you are working in, like Return, Tab, cmd+s, ctrl+Page_Down.",
      { keys: z.string().min(1).max(50), repeat: z.number().int().min(1).max(LIMITS.keyRepeat).optional() },
      {
        kind: "action",
        needsWorkingApp: true,
        receivers: keyboardReceivers,
        describe: ({ keys, repeat = 1 }) => `press ${keys}${repeat > 1 ? ` x${repeat}` : ""}`,
        act: ({ keys, repeat = 1 }) => engine.key(keys, repeat),
      },
    );

    register<{ name: string }>("open_app", "Open or switch to an app by name; it becomes the app you are working in.", { name: z.string().min(1).max(200) }, {
      kind: "action",
      needsWorkingApp: false,
      receivers: async ({ name }) => {
        const app = await engine.resolveApp(name);
        if (app === null) throw new Refusal(`No app named ${JSON.stringify(name)}`);
        return [{ bundleId: app.bundleId, name }];
      },
      describe: (_args, [app]) => `open ${appLabel(app)}`,
      act: async (_args, [app]) => engine.openApp(app.bundleId as string),
      after: (agentId, _args, [app]) => lease.setWorkingApp(agentId, app),
    });

    return mcp;
  }

  listen(port: number): Promise<Server> {
    const http = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        console.error(`[computerise] MCP request failed: ${String(error)}`);
        if (!res.headersSent) res.writeHead(500).end("Internal error");
      });
    });
    return new Promise((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, "127.0.0.1", () => {
        http.off("error", reject);
        resolve(http);
      });
    });
  }

  // Same shape as memorise's handler: POST only, token first, size cap, a fresh server per request.
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== PATH) {
      res.writeHead(404).end(`Expected ${PATH}`);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end("Only POST is supported");
      return;
    }
    const scope = this.options.tokens.verify(req.headers.authorization);
    if (!scope) {
      res.writeHead(401).end("Computer token missing or not valid. Recreate the agent to get a new one.");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_REQUEST_BYTES) {
        res.writeHead(413).end(`Request larger than ${MAX_REQUEST_BYTES} bytes`);
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try {
      body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } catch {
      res.writeHead(400).end("Expected a JSON-RPC request body");
      return;
    }
    const mcp = this.buildServer(scope.seat);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
