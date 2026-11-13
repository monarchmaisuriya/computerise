import { z } from "zod";
import { type Mode, modeSchema, type Settings } from "../shared/contracts";
import { BUILT_IN_BLOCKS, PASEO_BUNDLE_ID } from "../shared/blocks";
import { readJsonFile, writeJsonFile } from "./json-file";

// The mode of an agent the user has not set one for.
export const DEFAULT_MODE: Mode = "ask";

export type BlockLevel = "none" | "no-input" | "no-view";
// within lists the bundle ids of the app bundles that contain the app, innermost first.
export type AppRef = { bundleId: string | null; name: string; within: readonly string[] };
export type Point = { x: number; y: number };

const STRICTNESS: readonly BlockLevel[] = ["none", "no-input", "no-view"];

// An app inside a blocked app's bundle, such as its menu-bar helper, is blocked at least as strictly
// as every app that contains it.
export function blockLevel(app: { bundleId: string | null; within: readonly string[] }, settings: Settings): BlockLevel {
  const levels = [app.bundleId, ...app.within].map((bundleId) => ownLevel(bundleId, settings));
  return levels.reduce((strictest, level) => (STRICTNESS.indexOf(level) > STRICTNESS.indexOf(strictest) ? level : strictest));
}

// An app without a bundle id cannot be matched against the list, so it is not acted on.
function ownLevel(bundleId: string | null, settings: Settings): BlockLevel {
  if (bundleId === null) return "no-input";
  if (bundleId === PASEO_BUNDLE_ID) return "no-input";
  if (settings.extraNoView.includes(bundleId)) return "no-view";
  const builtIn = BUILT_IN_BLOCKS.find((block) => block.bundleId === bundleId);
  if (builtIn) return builtIn.level;
  if (settings.extraNoInput.includes(bundleId)) return "no-input";
  return "none";
}

export class LeaseHeldError extends Error {
  constructor(readonly holder: string) {
    super(`Agent ${holder} is using the screen`);
  }
}

// One agent drives the mouse and keyboard at a time. The lease also remembers the app that agent is
// working in, so actions approved later still go to that app.
// Each take by an agent that did not hold the screen starts a new turn number, so an action planned
// before a release (turn end, close, Stop, idle) can tell it no longer holds the screen it planned on.
export class Lease {
  private holder: { agentId: string; workingApp: AppRef | null; lastCall: number; turn: number } | null = null;
  private turns = 0;

  constructor(
    private readonly idleMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private current(): typeof this.holder {
    if (this.holder && this.now() - this.holder.lastCall >= this.idleMs) this.holder = null;
    return this.holder;
  }

  take(agentId: string): number {
    const holder = this.current();
    if (holder && holder.agentId !== agentId) throw new LeaseHeldError(holder.agentId);
    if (holder) {
      holder.lastCall = this.now();
      return holder.turn;
    }
    this.turns += 1;
    this.holder = { agentId, workingApp: null, lastCall: this.now(), turn: this.turns };
    return this.turns;
  }

  holderId(): string | null {
    return this.current()?.agentId ?? null;
  }

  // Counts as a call: an action waiting for the user's answer keeps the screen, so no other agent
  // takes it meanwhile. A turn that was released or lapsed stays gone.
  keepAlive(agentId: string, turn: number): void {
    const holder = this.current();
    if (holder?.agentId === agentId && holder.turn === turn) holder.lastCall = this.now();
  }

  holds(agentId: string, turn: number): boolean {
    const holder = this.current();
    return holder?.agentId === agentId && holder.turn === turn;
  }

  release(agentId: string): void {
    if (this.holder?.agentId === agentId) this.holder = null;
  }

  releaseAll(): void {
    this.holder = null;
  }

  workingApp(agentId: string): AppRef | null {
    const holder = this.current();
    return holder?.agentId === agentId ? holder.workingApp : null;
  }

  setWorkingApp(agentId: string, app: AppRef): void {
    const holder = this.current();
    if (holder?.agentId !== agentId) throw new Error(`Agent ${agentId} does not hold the screen`);
    holder.workingApp = app;
  }
}

export class RateLimiter {
  private readonly times = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(agentId: string): void {
    const now = this.now();
    const recent = (this.times.get(agentId) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.limit) throw new Error(`Refused: ${this.limit} actions in the last minute. Slow down.`);
    this.times.set(agentId, [...recent, now]);
  }

  release(agentId: string): void {
    this.times.delete(agentId);
  }
}

const CORNER_POINTS = 2;

function inCorner(point: Point): boolean {
  return point.x <= CORNER_POINTS && point.y <= CORNER_POINTS;
}

// The user stops computer use by pushing the pointer into the top-left corner. A pointer the plugin
// itself put there does not count.
export class Failsafe {
  private lastPlaced: Point | null = null;

  notePlaced(point: Point): void {
    this.lastPlaced = point;
  }

  // The agent's own placement excuses one check, its next call, so it cannot park the pointer in
  // the corner. Reads that report an action's own result pass keepPlacement and leave it for that call.
  tripped(cursor: Point, { keepPlacement = false } = {}): boolean {
    const placedInCorner = this.lastPlaced !== null && inCorner(this.lastPlaced);
    if (!keepPlacement) this.lastPlaced = null;
    return inCorner(cursor) && !placedInCorner;
  }
}

// How much each mode allows; a lower rank never allows anything a higher one does not.
export const MODE_RANK: Record<Mode, number> = { off: 0, ask: 1, auto: 2 };

// version 2: an agent without a saved mode is in DEFAULT_MODE. Files without it are older, when
// such an agent was off.
const controlSchema = z.object({ version: z.literal(2).optional(), modes: z.record(z.string(), modeSchema), stopped: z.boolean() });
type Control = z.infer<typeof controlSchema>;

// Per-agent modes and the global stop, kept on disk so a restart or crash loop cannot clear a stop.
export class ControlStore {
  private writes: Promise<void> = Promise.resolve();
  private revision = 0;

  private constructor(
    private readonly path: string,
    private state: Control,
    readonly problem: string | null,
  ) {}

  static async open(path: string): Promise<ControlStore> {
    const { value, problem } = await readJsonFile(path, controlSchema, { modes: {}, stopped: false });
    return new ControlStore(path, value, problem);
  }

  mode(agentId: string): Mode {
    return Object.hasOwn(this.state.modes, agentId) ? this.state.modes[agentId] : DEFAULT_MODE;
  }

  stopped(): boolean {
    return this.state.stopped;
  }

  modes(): Record<string, Mode> {
    return { ...this.state.modes };
  }

  // A mode that allows less (auto to ask, anything to off) is the safer change, so it applies at once
  // and wins over any save in flight; a mode that allows more applies only once it is saved.
  setMode(agentId: string, mode: Mode): Promise<void> {
    const parsed = modeSchema.parse(mode);
    const lowers = MODE_RANK[parsed] <= MODE_RANK[this.mode(agentId)];
    return this.save((current) => ({ ...current, modes: { ...current.modes, [agentId]: parsed } }), lowers);
  }

  setStopped(stopped: boolean): Promise<void> {
    return this.save((current) => ({ ...current, stopped }), stopped);
  }

  // Saves Off for every agent that already has the tools and no saved mode, once, so an upgrade or an
  // unreadable file never gives an existing agent more access; only agents created later start in
  // DEFAULT_MODE. Applied in memory even if the write fails, and repeated on the next start.
  keepExistingAgentsOff(agentIds: readonly string[]): Promise<void> {
    if (this.state.version === 2) return Promise.resolve();
    return this.save((current) => ({ ...current, version: 2, modes: { ...Object.fromEntries(agentIds.map((agentId) => [agentId, "off" as const])), ...current.modes } }), true);
  }

  removeAgent(agentId: string): Promise<void> {
    return this.save((current) => {
      const modes = { ...current.modes };
      delete modes[agentId];
      return { ...current, modes };
    }, true);
  }

  private save(change: (current: Control) => Control, keepOnFailure = false): Promise<void> {
    let write: Promise<void>;
    if (keepOnFailure) {
      const next = change(this.state);
      this.state = next;
      this.revision += 1;
      write = this.writes.then(() => writeJsonFile(this.path, next));
    } else {
      write = this.writes.then(async () => {
        const revision = this.revision;
        const next = change(this.state);
        await writeJsonFile(this.path, next);
        // A safer change (Stop, a lower mode, a removal) may have happened during this write. Its queued
        // snapshot will repair disk next; never overwrite that safer in-memory state here.
        if (this.revision === revision) this.state = next;
      });
    }
    this.writes = write.catch(() => undefined);
    return write;
  }
}
