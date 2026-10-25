import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Mode, Settings } from "../shared/contracts";
import { type Approvals, type ApprovalScopes, singleApp } from "./approvals";
import type { AuditLog } from "./audit";
import { center, describeChange, describeElement, type ElementTables, type ExpectedElement, matchLive, pickElement } from "./elements";
import { LIMITS, type MacEngine, type MouseButton, type Point, type ScreenStatus, type ScrollDirection, type UiSnapshot } from "./engine";
import { type AppRef, blockLevel, type ControlStore, type Failsafe, type Lease, LeaseHeldError, type RateLimiter } from "./policy";
import type { Seats } from "./seats";
import type { TokenAuthority } from "./tokens";
import type { PanelState } from "./panel-state";
import { PLUGIN_VERSION } from "./version";

// Distinctive name: Paseo preapproves this server's tools by name, so a user's own server must not share it.
export const SERVER_NAME = "paseo-computerise";
export const TOOL_NAMES = ["click", "cursor_position", "drag", "key", "move", "open_app", "screenshot", "scroll", "status", "type", "ui_snapshot", "wait", "zoom"] as const;
const PATH = "/mcp";
const MAX_REQUEST_BYTES = 64 * 1024;
const FRONT_WAIT_MS = 1_000;
const FRONT_POLL_MS = 100;
const SHOWN_TEXT_CHARS = 300;
// Time for the screen to redraw before the reads that report an action's result.
const SETTLE_MS = 300;
const SNAPSHOT_ELEMENTS = 200;
const MAX_WAIT_SECONDS = 10;

export const OFF_MESSAGE = "Computer use is off for this agent; the user can turn it on with /computer ask";
const NOT_READY = "Computer use is not ready for this agent yet; try again in a moment";
const STOPPED = "Computer use is stopped by the user; they can resume it from the Computer panel";
const ELEMENT_OR_POINT = "Give either element, or both x and y";

export type Engine = Pick<
  MacEngine,
  "status" | "windowAt" | "activate" | "resolveApp" | "openApp" | "click" | "move" | "drag" | "scroll" | "type" | "key" | "screenshot" | "zoom" | "uiSnapshot" | "screenRecording" | "interrupt" | "openPrivacySettings" | "promptAccessibility" | "checkScreenRecording"
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
  scopes: ApprovalScopes;
  elements: ElementTables;
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
  run(agentId: string, args: A, status: ScreenStatus, settings: Settings): Promise<{ content: Content[]; accepted?(): void }>;
};

// The process whose windows a capture may show, or null for the whole display.
function capturedPid(status: ScreenStatus, settings: Settings): number | null {
  if (settings.screenshotScope === "display") return null;
  if (!status.front) throw new Refusal("No app is in front to capture");
  return status.front.pid;
}

// What an action acts on: the receivers (the apps that get the input) and, for pointer actions,
// the point, plus the control it names when given by element number. live is the window read just
// before acting, for an element action.
type Target = { apps: AppRef[]; point: Point | null; element: ExpectedElement | null; live?: UiSnapshot };

// The front window's controls just before an action, compared with a read after it; before is null
// when nothing was read (no app in front, or one blocked from view).
type Observed = { before: { pid: number; elements: UiSnapshot["elements"] } | null; max: number };

// The target is resolved before approval (planned is null) and again after the working app is back
// in front, given the planned target; both must name the same apps and pass the blocklist.
type ActionSpec<A> = {
  kind: "action";
  needsWorkingApp: boolean;
  // Pointer actions the user may allow for one app for the rest of the turn. Typing, keys, and
  // opening apps always ask.
  scopable?: true;
  target(agentId: string, args: A, working: AppRef | null, planned: Target | null): Promise<Target>;
  describe(args: A, target: Target): string;
  act(args: A, target: Target): Promise<void>;
  after?(agentId: string, args: A, target: Target): void;
  chars?(args: A): number;
};

type PointerArgs = { x?: number; y?: number; element?: number };

// Touches nothing on the Mac; still subject to identity, stop, mode, and rate checks.
type PauseSpec<A> = {
  kind: "pause";
  run(args: A): Promise<Content[]>;
};

// Reports the plugin's own state and reads only the status script. The one kind that answers while
// computer use is off or stopped, so the agent can tell the user what to do; it still needs a bound
// seat and counts toward the call limit.
type InfoSpec = {
  kind: "info";
  run(agentId: string): Promise<Content[]>;
};

type ToolSpec<A> = ReadSpec<A> | ActionSpec<A> | PauseSpec<A> | InfoSpec;

function textContent(text: string): Content[] {
  return [{ type: "text", text }];
}

function at(point: Point): string {
  return `(${point.x}, ${point.y})`;
}

function appLabel(app: AppRef): string {
  return `${app.name} (${app.bundleId ?? "unknown app"})`;
}

// The blocklist already refuses an app without a bundle id, so this only fails if that check moved.
function receiverId(app: AppRef | undefined): string {
  if (!app?.bundleId) throw new Refusal("No identifiable app is in front to receive the keys");
  return app.bundleId;
}

// Pointer targets always carry a point; only keyboard and open_app targets have none.
function pointOf(target: Target): Point {
  if (!target.point) throw new Error("A pointer action reached the Mac without a resolved point");
  return target.point;
}

// "(400, 220)", or "element 2 (AXButton "Save") at (140, 215)" when the agent named a control.
function where(target: Target): string {
  const point = at(pointOf(target));
  return target.element ? `element ${target.element.number} (${describeElement(target.element.element)}) at ${point}` : point;
}

function sameApps(a: AppRef[], b: AppRef[]): boolean {
  return a.length === b.length && a.every((app, i) => app.bundleId === b[i].bundleId);
}

function shownText(text: string): string {
  return text.length <= SHOWN_TEXT_CHARS ? JSON.stringify(text) : `${JSON.stringify(text.slice(0, SHOWN_TEXT_CHARS))}... (${text.length} characters)`;
}

const coordinate = z.number().describe("Main-display points, as read off the screenshot");
// Fixed-length arrays, not tuples: tuples become draft-07 array "items", which JSON Schema draft
// 2020-12 rejects, and with it Anthropic's API and every client that forwards to it.
const pair = z.array(coordinate).length(2).describe("[x, y] in main-display points");
const screenshotAfter = z.boolean().optional().describe("Also return a screenshot taken just after the action");
const elementNumber = z.number().int().min(1).max(LIMITS.snapshotElements).optional().describe("A control's number from your last ui_snapshot, instead of x and y");

function wantsScreenshot(args: unknown): boolean {
  return Reflect.get(Object(args), "screenshot") === true;
}

export class ComputerMcp {
  private executions: Promise<unknown> = Promise.resolve();
  private readonly screenshotSpec: ReadSpec<Record<string, never>>;

  constructor(private readonly options: ComputerMcpOptions) {
    this.screenshotSpec = {
      kind: "read",
      run: async (agentId, _args, status, settings) => {
        const pid = capturedPid(status, settings);
        const shot = await options.engine.screenshot(pid);
        const front = status.front ? appLabel(status.front) : "none";
        const scope = pid === null ? "" : "; only the front app's windows are shown, the rest is black";
        return {
          content: [
            { type: "image", data: shot.jpeg.toString("base64"), mimeType: "image/jpeg" },
            { type: "text", text: `Main display, ${shot.width} x ${shot.height} points; front app: ${front}; pointer at ${at(status.cursor)}${scope}` },
          ],
          accepted: () => options.panel?.screenshot(agentId, shot.jpeg, shot.width, shot.height),
        };
      },
    };
  }

  // Reads the front window's controls through the read checks; once the read is accepted they become
  // the agent's element numbers. report turns the read into the text the agent gets.
  private controlsSpec(max: number, report: (front: NonNullable<ScreenStatus["front"]>, snapshot: UiSnapshot) => string): ReadSpec<Record<string, never>> {
    return {
      kind: "read",
      run: async (agentId, _args, status) => {
        const front = status.front;
        if (!front) throw new Refusal("No app is in front");
        const snapshot = await this.options.engine.uiSnapshot(front.pid, max);
        return {
          content: textContent(report(front, snapshot)),
          accepted: () => this.options.elements.set(agentId, { pid: front.pid, app: { bundleId: front.bundleId, name: front.name }, max, elements: snapshot.elements }),
        };
      },
    };
  }

  // Never reads an app blocked from view, the same rule the read path applies.
  private async controlsBefore(status: ScreenStatus, settings: Settings, max: number): Promise<Observed["before"]> {
    const front = status.front;
    if (!front || blockLevel(front.bundleId, settings) === "no-view") return null;
    return { pid: front.pid, elements: (await this.options.engine.uiSnapshot(front.pid, max)).elements };
  }

  async stopAll(): Promise<void> {
    let persistenceError: unknown;
    await this.options.control.setStopped(true).catch((error: unknown) => {
      persistenceError = error;
    });
    this.options.approvals.cancelAll();
    this.options.scopes.clearAll();
    this.options.elements.clearAll();
    this.options.lease.releaseAll();
    this.options.engine.interrupt();
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

  private async read<A>(agentId: string, spec: ReadSpec<A>, args: A, status: ScreenStatus, settings: Settings, afterAction: boolean) {
    const front = status.front;
    if (front && blockLevel(front.bundleId, settings) === "no-view") throw new Refusal(`${appLabel(front)} is blocked from view`);
    const result = await spec.run(agentId, args, status, settings);
    const after = await this.options.engine.status();
    if (after.front && blockLevel(after.front.bundleId, settings) === "no-view") throw new Refusal(`${appLabel(after.front)} is blocked from view`);
    if (after.front?.pid !== front?.pid || after.front?.bundleId !== front?.bundleId) throw new Refusal("The screen changed while reading; try again");
    // Input goes where the agent chose to look or what it opened; an automatic read after an action
    // (for example while an app opened by open_app is still launching) never redirects it.
    if (front && !afterAction) this.options.lease.setWorkingApp(agentId, { bundleId: front.bundleId, name: front.name });
    result.accepted?.();
    return { content: result.content, target: front?.bundleId ?? null };
  }

  private async act<A>(agentId: string, mode: Mode, spec: ActionSpec<A>, args: A, settings: Settings) {
    const { approvals, scopes, lease } = this.options;
    const working = lease.workingApp(agentId);
    if (spec.needsWorkingApp && working === null) throw new Refusal("Take a screenshot first, so the plugin knows which app you are working in");
    const planned = await spec.target(agentId, args, working, null);
    this.requireInputAllowed(planned.apps, settings);
    const description = spec.describe(args, planned);
    if (mode === "ask" && !(spec.scopable && scopes.covers(agentId, planned.apps))) {
      const scopeApp = spec.scopable ? singleApp(planned.apps) : null;
      const decision = await approvals.request(agentId, description, [...new Set(planned.apps.map((app) => app.name))].join(", "), scopeApp?.name ?? null);
      if (decision === "deny") throw new Refusal("The user denied this action");
      if (decision === "timeout") throw new Refusal("The user did not answer in time; nothing was done");
      if (decision === "cancelled") throw new Refusal("The request was withdrawn before it was answered (Stop, a mode change, or the end of the agent's turn); nothing was done");
      this.requireRunning(agentId);
      if (decision === "allow-app" && scopeApp) scopes.allow(agentId, scopeApp.bundleId);
    }
    return this.exclusive(async () => {
      if (lease.holderId() !== agentId) throw new Refusal("The screen was released while this action waited (for example, the agent's turn ended); take a new screenshot");
      if (spec.needsWorkingApp && working !== null) await this.bringForward(working);
      const actual = await spec.target(agentId, args, working, planned);
      if (!sameApps(planned.apps, actual.apps)) throw new Refusal("The screen changed while waiting; take a new screenshot");
      const executionStatus = await this.options.engine.status();
      const executionSettings = await this.options.settings();
      this.requireRunning(agentId);
      if (this.options.failsafe.tripped(executionStatus.cursor)) {
        await this.stopAll();
        throw new Refusal("The pointer is in the top-left corner, so computer use is now stopped; the user can resume it from the Computer panel");
      }
      this.requireInputAllowed(actual.apps, executionSettings);
      const max = this.options.elements.get(agentId)?.max ?? SNAPSHOT_ELEMENTS;
      const before = actual.live && actual.element ? { pid: actual.element.pid, elements: actual.live.elements } : await this.controlsBefore(executionStatus, executionSettings, max);
      await spec.act(args, actual);
      spec.after?.(agentId, args, actual);
      const observed: Observed = { before, max };
      return { content: textContent(`Done: ${description}`), target: actual.apps.map((app) => app.bundleId).join(","), observed };
    });
  }

  // The action already happened, so a refused or failed read after it is reported, not raised. It
  // passes the same stop, mode, corner, lease, and view checks as a read the agent asked for
  // separately, and is audited as one. The state read belongs to every action, so only a screenshot
  // the agent asked for is charged to its call limit.
  private async readAfterAction(agentId: string, tool: "screenshot" | "ui_snapshot", spec: ReadSpec<Record<string, never>>, refusal: string): Promise<Content[]> {
    const { audit, panel, calls } = this.options;
    let target: string | null = null;
    try {
      const mode = this.requireRunning(agentId);
      if (tool === "screenshot") calls.take(agentId);
      const result = await this.onScreen(agentId, mode, spec, {}, true);
      target = result.target;
      await audit.record({ agentId, tool, target, outcome: "ok" });
      panel?.activity({ agentId, tool, target, outcome: "ok" });
      return result.content;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = error instanceof Refusal ? `refused: ${message}` : `error: ${message}`;
      await audit.record({ agentId, tool, target, outcome }).catch((auditError: unknown) => console.error(`[computerise] audit write failed: ${String(auditError)}`));
      panel?.activity({ agentId, tool, target, outcome });
      return textContent(`${refusal}: ${message}`);
    }
  }

  // What the action changed in the front window. Numbers from before the action may now name other
  // controls, so they are replaced by this read, or dropped if it is refused.
  private async stateAfterAction(agentId: string, { before, max }: Observed): Promise<Content[]> {
    this.options.elements.clear(agentId);
    const spec = this.controlsSpec(max, (front, after) => describeChange(before, { pid: front.pid, app: { bundleId: front.bundleId, name: front.name }, elements: after.elements, cut: after.cut }));
    return this.readAfterAction(agentId, "ui_snapshot", spec, "No state");
  }

  // afterAction marks the reads that report an action's own result: they keep the agent's own
  // pointer placement excused (Failsafe.tripped), never change the working app (read), and never take
  // the screen back for an agent that let go of it during the action (turn end, close).
  private async onScreen<A>(agentId: string, mode: Mode, spec: ReadSpec<A> | ActionSpec<A>, args: A, afterAction = false): Promise<{ content: Content[]; target: string | null; observed?: Observed }> {
    const { engine, failsafe, lease } = this.options;
    const status = await engine.status();
    if (failsafe.tripped(status.cursor, { keepPlacement: afterAction })) {
      await this.stopAll();
      throw new Refusal("The pointer is in the top-left corner, so computer use is now stopped; the user can resume it from the Computer panel");
    }
    if (afterAction) {
      if (lease.holderId() !== agentId) throw new Refusal("The screen was released after this action (for example, the agent's turn ended)");
    } else {
      try {
        lease.take(agentId);
      } catch (error) {
        if (error instanceof LeaseHeldError) throw new Refusal(`Agent ${await this.options.agentTitle(error.holder)} is using the screen`);
        throw error;
      }
    }
    const settings = await this.options.settings();
    return spec.kind === "read" ? this.read(agentId, spec, args, status, settings, afterAction) : this.act(agentId, mode, spec, args, settings);
  }

  private async statusReport(agentId: string): Promise<string> {
    const { control, lease, engine, elements } = this.options;
    const mode = control.mode(agentId);
    const holder = lease.holderId();
    let accessibility: string;
    try {
      accessibility = (await engine.status()).trusted ? "granted" : "missing; the user grants it to Paseo in System Settings > Privacy & Security > Accessibility, or from the Computer panel";
    } catch (error) {
      accessibility = `unknown (${error instanceof Error ? error.message : String(error)})`;
    }
    const recording = engine.screenRecording();
    const working = lease.workingApp(agentId);
    const table = elements.get(agentId);
    return [
      `Mode: ${mode === "off" ? "off; the user can turn it on with /computer ask or /computer auto" : mode === "ask" ? "ask (the user approves each input action)" : "auto (input actions run without approval)"}`,
      control.stopped() ? "Stopped by the user; they can resume it from the Computer panel" : "Not stopped",
      `Screen: ${holder === null ? "free" : holder === agentId ? "held by you" : `held by agent ${await this.options.agentTitle(holder)}`}`,
      `Accessibility: ${accessibility}`,
      `Screen Recording: ${recording === "granted" ? "granted" : recording === "missing" ? "missing; the user grants it to Paseo in System Settings > Privacy & Security > Screen Recording, then reopens Paseo" : "not checked yet; the user can check it in the Computer panel"}`,
      `Working app: ${working ? appLabel(working) : "none; take a screenshot or ui_snapshot first"}`,
      `Element numbers: ${table ? `${table.elements.length} controls from ${table.app.name}` : "none; call ui_snapshot"}`,
    ].join("\n");
  }

  // Every tool runs through here, in this order: identity, stop, mode, rate limit, then (for tools
  // that touch the screen) corner failsafe, lease, and the read or action path. status skips only the
  // stop and mode checks (InfoSpec). Argument schemas are checked by the MCP server before.
  private async call<A>(seat: string, tool: string, spec: ToolSpec<A>, args: A) {
    const { seats, calls, rates, audit } = this.options;
    let agentId: string | null = null;
    let target: string | null = null;
    const chars = spec.kind === "action" ? spec.chars?.(args) : undefined;
    try {
      agentId = seats.agentFor(seat);
      if (agentId === null) throw new Refusal(NOT_READY);
      const mode = spec.kind === "info" ? this.options.control.mode(agentId) : this.requireRunning(agentId);
      calls.take(agentId);
      if (spec.kind === "action") rates.take(agentId);
      const result =
        spec.kind === "pause" ? { content: await spec.run(args), target: null } : spec.kind === "info" ? { content: await spec.run(agentId), target: null } : await this.onScreen(agentId, mode, spec, args);
      target = result.target;
      await audit.record({ agentId, tool, target, outcome: "ok", chars });
      this.options.panel?.activity({ agentId, tool, target, outcome: "ok", chars });
      if (!result.observed) return { content: result.content };
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      const state = await this.stateAfterAction(agentId, result.observed);
      const shot = wantsScreenshot(args) ? await this.readAfterAction(agentId, "screenshot", this.screenshotSpec, "No screenshot") : [];
      return { content: [...result.content, ...state, ...shot] };
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
    // Annotations are hints for clients; the pipeline above is what enforces the rules.
    const register = <A>(name: (typeof TOOL_NAMES)[number], title: string, description: string, inputSchema: z.ZodRawShape, spec: ToolSpec<A>) => {
      mcp.registerTool(name, { title, description, inputSchema, annotations: { readOnlyHint: spec.kind !== "action" } }, (args: unknown) => this.call(seat, name, spec, args as A));
    };
    // A point given directly, or the middle of a control from the agent's last ui_snapshot. Before
    // acting, the control's window is read again and must still list that control under the number
    // the user approved; the point then comes from that fresh read.
    const pointerTarget = async (agentId: string, { x, y, element }: PointerArgs, _working: AppRef | null, planned: Target | null): Promise<Target> => {
      if (element === undefined) {
        if (x === undefined || y === undefined) throw new Refusal(ELEMENT_OR_POINT);
        return { apps: [await this.appAt({ x, y })], point: { x, y }, element: null };
      }
      if (x !== undefined || y !== undefined) throw new Refusal(ELEMENT_OR_POINT);
      let expected: ExpectedElement;
      let frame: ExpectedElement["element"]["frame"];
      let liveRead: UiSnapshot | undefined;
      if (planned?.element) {
        expected = planned.element;
        // The user may have blocked the app while the action waited; a blocked app is never read.
        this.requireInputAllowed([expected.app], await this.options.settings());
        if ((await engine.status()).front?.pid !== expected.pid) throw new Refusal(`${expected.app.name} is no longer in front; call ui_snapshot again`);
        liveRead = await engine.uiSnapshot(expected.pid, expected.max);
        const live = matchLive(expected, liveRead);
        if ("refusal" in live) throw new Refusal(live.refusal);
        frame = live.element.frame;
      } else {
        const picked = pickElement(this.options.elements.get(agentId), element);
        if ("refusal" in picked) throw new Refusal(picked.refusal);
        expected = picked.expected;
        frame = expected.element.frame;
      }
      const point = center(frame);
      const app = await this.appAt(point);
      if (app.bundleId !== expected.app.bundleId) throw new Refusal(`Element ${element} is not on ${expected.app.name}'s window at ${at(point)}: ${app.name} is there`);
      return { apps: [app], point, element: expected, live: liveRead };
    };
    // Keyboard input goes to the front app; before approval that is meant to be the working app.
    const keyboardTarget = async (_agentId: string, _args: unknown, working: AppRef | null, planned: Target | null): Promise<Target> => {
      if (planned === null) return { apps: working ? [working] : [], point: null, element: null };
      const front = (await engine.status()).front;
      return { apps: front ? [{ bundleId: front.bundleId, name: front.name }] : [], point: null, element: null };
    };

    register<Record<string, never>>(
      "status",
      "Status",
      "Report whether computer use is on for you or stopped, who holds the screen, whether Paseo has the macOS permissions, and which app your input goes to. Answers even when computer use is off.",
      {},
      { kind: "info", run: async (agentId) => textContent(await this.statusReport(agentId)) },
    );

    register("screenshot", "Screenshot", "Capture the main display. The image is at point size: a coordinate read off it is the coordinate to click.", {}, this.screenshotSpec);

    register<Record<string, never>>("cursor_position", "Pointer position", "Report where the pointer is and which app is in front.", {}, {
      kind: "read",
      run: async (_agentId, _args, status) => {
        const front = status.front ? appLabel(status.front) : "none";
        return { content: textContent(`Pointer at ${at({ x: Math.round(status.cursor.x), y: Math.round(status.cursor.y) })}; front app: ${front}`) };
      },
    });

    register<{ seconds: number }>(
      "wait",
      "Wait",
      `Wait for an app to finish loading or animating, up to ${MAX_WAIT_SECONDS} seconds. Takes no screenshot.`,
      { seconds: z.number().min(0.1).max(MAX_WAIT_SECONDS) },
      {
        kind: "pause",
        run: async ({ seconds }) => {
          await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
          return textContent(`Waited ${seconds} seconds`);
        },
      },
    );

    register<{ region: [number, number, number, number] }>(
      "zoom",
      "Zoom",
      "Capture a region of the main display at full pixel resolution, to read small text.",
      { region: z.array(z.number().int()).length(4).describe("[x0, y0, x1, y1] in points") },
      {
        kind: "read",
        run: async (_agentId, { region }, status, settings) => {
          const shot = await engine.zoom(region, capturedPid(status, settings));
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
      "Accessibility snapshot",
      "List the front window's controls as text (role, label, value, frame in points), for reading the screen without images. Pass a control's number as element to click, move, or scroll to act on it; the action is refused if that control changed.",
      { max_elements: z.number().int().min(1).max(LIMITS.snapshotElements).optional() },
      {
        kind: "read",
        run: (agentId, { max_elements }, status, settings) =>
          this.controlsSpec(max_elements ?? SNAPSHOT_ELEMENTS, (front, snapshot) => {
            const lines = snapshot.elements.map((element, i) => {
              const label = element.label ? ` ${JSON.stringify(element.label)}` : "";
              const value = element.value !== null ? ` value=${JSON.stringify(element.value)}` : "";
              const frame = element.frame ? ` at ${element.frame[0]},${element.frame[1]} ${element.frame[2]}x${element.frame[3]}` : "";
              return `${i + 1}. ${element.role ?? "unknown"}${label}${value}${frame}`;
            });
            const cut = snapshot.cut ? ", cut short" : "";
            return [`Front window of ${appLabel(front)} (${lines.length} elements${cut}):`, ...lines].join("\n");
          }).run(agentId, {}, status, settings),
      },
    );

    register<PointerArgs & { button?: MouseButton; count?: number; modifiers?: string[] }>(
      "click",
      "Click",
      "Click at a point, or on a control by its number from your last ui_snapshot.",
      {
        x: coordinate.optional(),
        y: coordinate.optional(),
        element: elementNumber,
        screenshot: screenshotAfter,
        button: z.enum(["left", "right", "middle"]).optional(),
        count: z.number().int().min(1).max(LIMITS.clickCount).optional().describe("2 for a double click"),
        modifiers: z.array(z.string().max(10)).max(4).optional().describe("cmd, shift, option, ctrl"),
      },
      {
        kind: "action",
        needsWorkingApp: true,
        scopable: true,
        target: pointerTarget,
        describe: ({ button = "left", count = 1, modifiers = [] }, target) =>
          `click ${button}${count > 1 ? ` x${count}` : ""}${modifiers.length ? ` with ${modifiers.join("+")}` : ""} ${target.element ? "on" : "at"} ${where(target)} on ${target.apps[0].name}`,
        act: ({ button = "left", count = 1, modifiers = [] }, target) => engine.click(pointOf(target), { button, count, modifiers }),
        after: (_agentId, _args, target) => failsafe.notePlaced(pointOf(target)),
      },
    );

    register<PointerArgs>(
      "move",
      "Move",
      "Move the pointer to a point, or to a control by its number from your last ui_snapshot.",
      { x: coordinate.optional(), y: coordinate.optional(), element: elementNumber, screenshot: screenshotAfter },
      {
        kind: "action",
        needsWorkingApp: true,
        scopable: true,
        target: pointerTarget,
        describe: (_args, target) => `move the pointer to ${where(target)} over ${target.apps[0].name}`,
        act: (_args, target) => engine.move(pointOf(target)),
        after: (_agentId, _args, target) => failsafe.notePlaced(pointOf(target)),
      },
    );

    register<{ from: [number, number]; to: [number, number] }>("drag", "Drag", "Press the left button at one point, move to another, and release.", { from: pair, to: pair, screenshot: screenshotAfter }, {
      kind: "action",
      needsWorkingApp: true,
      scopable: true,
      target: async (_agentId, { from, to }) => ({ apps: [await this.appAt({ x: from[0], y: from[1] }), await this.appAt({ x: to[0], y: to[1] })], point: null, element: null }),
      describe: ({ from, to }, { apps: [start, end] }) => `drag from ${at({ x: from[0], y: from[1] })} on ${start.name} to ${at({ x: to[0], y: to[1] })} on ${end.name}`,
      act: ({ from, to }) => engine.drag({ x: from[0], y: from[1] }, { x: to[0], y: to[1] }),
      after: (_agentId, { to }) => failsafe.notePlaced({ x: to[0], y: to[1] }),
    });

    register<PointerArgs & { direction: ScrollDirection; amount?: number }>(
      "scroll",
      "Scroll",
      "Scroll by lines at a point, or on a control by its number from your last ui_snapshot.",
      {
        x: coordinate.optional(),
        y: coordinate.optional(),
        element: elementNumber,
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().int().min(1).max(LIMITS.scrollAmount).optional(),
        screenshot: screenshotAfter,
      },
      {
        kind: "action",
        needsWorkingApp: true,
        scopable: true,
        target: pointerTarget,
        describe: ({ direction, amount = 3 }, target) => `scroll ${direction} ${amount} ${target.element ? "on" : "at"} ${where(target)} on ${target.apps[0].name}`,
        act: ({ direction, amount = 3 }, target) => engine.scroll(pointOf(target), direction, amount),
        after: (_agentId, _args, target) => failsafe.notePlaced(pointOf(target)),
      },
    );

    register<{ text: string }>("type", "Type", "Type text into the app you are working in.", { text: z.string().min(1).max(LIMITS.typeUnits), screenshot: screenshotAfter }, {
      kind: "action",
      needsWorkingApp: true,
      target: keyboardTarget,
      describe: ({ text }) => `type ${shownText(text)}`,
      act: ({ text }, { apps: [app] }) => engine.type(text, receiverId(app)),
      chars: ({ text }) => text.length,
    });

    register<{ keys: string; repeat?: number }>(
      "key",
      "Key press",
      "Press a key combination in the app you are working in, like Return, Tab, cmd+s, ctrl+Page_Down.",
      { keys: z.string().min(1).max(50), repeat: z.number().int().min(1).max(LIMITS.keyRepeat).optional(), screenshot: screenshotAfter },
      {
        kind: "action",
        needsWorkingApp: true,
        target: keyboardTarget,
        describe: ({ keys, repeat = 1 }) => `press ${keys}${repeat > 1 ? ` x${repeat}` : ""}`,
        act: ({ keys, repeat = 1 }, { apps: [app] }) => engine.key(keys, repeat, receiverId(app)),
      },
    );

    register<{ name: string }>("open_app", "Open app", "Open or switch to an app by name; it becomes the app you are working in.", { name: z.string().min(1).max(200), screenshot: screenshotAfter }, {
      kind: "action",
      needsWorkingApp: false,
      target: async (_agentId, { name }) => {
        const app = await engine.resolveApp(name);
        if (app === null) throw new Refusal(`No app named ${JSON.stringify(name)}`);
        return { apps: [{ bundleId: app.bundleId, name }], point: null, element: null };
      },
      describe: (_args, { apps: [app] }) => `open ${appLabel(app)}`,
      act: async (_args, { apps: [app] }) => engine.openApp(app.bundleId as string),
      after: (agentId, _args, { apps: [app] }) => lease.setWorkingApp(agentId, app),
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
