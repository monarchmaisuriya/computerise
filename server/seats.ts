import { randomBytes } from "node:crypto";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-file";

const SEAT_BYTES = 16;

const seatsSchema = z.record(z.string(), z.string());

// The agent.create hook runs before the agent has an id, so the plugin hands out a seat there and
// binds it to the agent id in agent.session_open (reason "create"). Tokens name the seat.
export class Seats {
  private writes: Promise<void> = Promise.resolve();
  private revision = 0;

  private constructor(
    private readonly path: string,
    private bindings: Record<string, string>,
    readonly problem: string | null,
  ) {}

  static async open(path: string): Promise<Seats> {
    const { value, problem } = await readJsonFile(path, seatsSchema, {});
    return new Seats(path, value, problem);
  }

  mint(): string {
    return randomBytes(SEAT_BYTES).toString("base64url");
  }

  agentFor(seat: string): string | null {
    return Object.hasOwn(this.bindings, seat) ? this.bindings[seat] : null;
  }

  bind(seat: string, agentId: string): Promise<void> {
    const write = this.writes.then(async () => {
      const bound = this.agentFor(seat);
      if (bound === agentId) return;
      if (bound !== null) throw new Error(`Seat ${seat} already belongs to agent ${bound}`);
      const revision = this.revision;
      const next = { ...this.bindings, [seat]: agentId };
      await writeJsonFile(this.path, next);
      if (this.revision === revision) this.bindings = next;
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  revokeAgent(agentId: string): Promise<void> {
    const next = Object.fromEntries(Object.entries(this.bindings).filter(([, bound]) => bound !== agentId));
    this.bindings = next;
    this.revision += 1;
    const write = this.writes.then(() => writeJsonFile(this.path, next));
    this.writes = write.catch(() => undefined);
    return write;
  }
}
