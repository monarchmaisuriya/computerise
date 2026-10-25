import { z } from "zod";
import { type Mode, modeSchema, type Settings } from "../shared/contracts";
import { BUILT_IN_BLOCKS, PASEO_BUNDLE_ID } from "../shared/blocks";
import { readJsonFile, writeJsonFile } from "./json-file";

export type BlockLevel = "none" | "no-input" | "no-view";
export type AppRef = { bundleId: string | null; name: string };
export type Point = { x: number; y: number };

// An app without a bundle id cannot be matched against the list, so it is not acted on.
export function blockLevel(bundleId: string | null, settings: Settings): BlockLevel {
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
export class Lease {
  private holder: { agentId: string; workingApp: AppRef | null; lastCall: number } | null = null;

  constructor(
    private readonly idleMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private current(): typeof this.holder {
    if (this.holder && this.now() - this.holder.lastCall >= this.idleMs) this.holder = null;
    return this.holder;
  }

  take(agentId: string): void {
    const holder = this.current();
    if (holder && holder.agentId !== agentId) throw new LeaseHeldError(holder.agentId);
    if (holder) holder.lastCall = this.now();
    else this.holder = { agentId, workingApp: null, lastCall: this.now() };
  }

  holderId(): string | null {
    return this.current()?.agentId ?? null;
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

  tripped(cursor: Point): boolean {
    const placedInCorner = this.lastPlaced !== null && inCorner(this.lastPlaced);
    this.lastPlaced = null;
    return inCorner(cursor) && !placedInCorner;
  }
}

const controlSchema = z.object({ modes: z.record(z.string(), modeSchema), stopped: z.boolean() });
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
    return Object.hasOwn(this.state.modes, agentId) ? this.state.modes[agentId] : "off";
  }

  stopped(): boolean {
    return this.state.stopped;
  }

  modes(): Record<string, Mode> {
    return { ...this.state.modes };
  }

  setMode(agentId: string, mode: Mode): Promise<void> {
    const parsed = modeSchema.parse(mode);
    return this.save((current) => ({ ...current, modes: { ...current.modes, [agentId]: parsed } }), parsed === "off");
  }

  setStopped(stopped: boolean): Promise<void> {
    return this.save((current) => ({ ...current, stopped }), stopped);
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
        // A safer Stop/Off/removal may have happened while this write was in flight. Its queued
        // snapshot will repair disk next; never overwrite that safer in-memory state here.
        if (this.revision === revision) this.state = next;
      });
    }
    this.writes = write.catch(() => undefined);
    return write;
  }
}
