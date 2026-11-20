import { randomBytes } from "node:crypto";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-file";

const SEAT_BYTES = 16;

const seatsSchema = z.record(z.string(), z.string());

// Tokens name a persistent seat. Adaptive opens reuse it by actual agent id, never by saved env.
export class Seats {
  private writes: Promise<void> = Promise.resolve();
  private revision = 0;
  private readonly retained = new Set<string>();
  private readonly provisional = new Set<string>();
  private readonly openings = new Map<string, number>();

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

  // Every agent that has the computer tools.
  agents(): string[] {
    return [...new Set(Object.values(this.bindings))];
  }

  ensure(agentId: string): Promise<{ seat: string; allocated: boolean }> {
    const write = this.writes.then(async () => {
      const existing = Object.entries(this.bindings).find(([, bound]) => bound === agentId)?.[0];
      if (existing) {
        return { seat: existing, allocated: false };
      }
      const seat = this.mint();
      const revision = this.revision;
      const next = { ...this.bindings, [seat]: agentId };
      await writeJsonFile(this.path, next);
      if (revision !== this.revision) throw new Error(`Seat allocation for agent ${agentId} was superseded by revocation`);
      this.bindings = next;
      this.provisional.add(seat);
      return { seat, allocated: true };
    });
    this.writes = write.then(() => undefined, () => undefined);
    return write;
  }

  retain(seat: string, agentId: string): void {
    if (this.agentFor(seat) !== agentId) throw new Error(`Seat does not belong to agent ${agentId}`);
    this.retained.add(seat);
    this.provisional.delete(seat);
  }

  holdOpening(seat: string, agentId: string): void {
    if (this.agentFor(seat) !== agentId) throw new Error(`Seat does not belong to agent ${agentId}`);
    this.openings.set(seat, (this.openings.get(seat) ?? 0) + 1);
  }

  async releaseOpening(seat: string, agentId: string, installed: boolean): Promise<void> {
    const count = this.openings.get(seat) ?? 0;
    if (count <= 1) this.openings.delete(seat);
    else this.openings.set(seat, count - 1);
    if (!installed && this.provisional.has(seat)) await this.revokeProvisional(seat, agentId);
  }

  revokeProvisional(seat: string, agentId: string): Promise<void> {
    const write = this.writes.then(async () => {
      const bound = this.agentFor(seat);
      if (bound === null) return;
      if (bound !== agentId) throw new Error(`Provisional seat does not belong to agent ${agentId}`);
      if (this.retained.has(seat) || !this.provisional.has(seat) || this.openings.has(seat)) return;
      const next = { ...this.bindings };
      delete next[seat];
      this.bindings = next;
      this.provisional.delete(seat);
      this.revision += 1;
      await writeJsonFile(this.path, next);
    });
    this.writes = write.catch(() => undefined);
    return write;
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
    for (const [seat, bound] of Object.entries(this.bindings)) if (bound === agentId) {
      this.retained.delete(seat);
      this.provisional.delete(seat);
      this.openings.delete(seat);
    }
    const next = Object.fromEntries(Object.entries(this.bindings).filter(([, bound]) => bound !== agentId));
    this.bindings = next;
    this.revision += 1;
    const write = this.writes.then(() => writeJsonFile(this.path, next));
    this.writes = write.catch(() => undefined);
    return write;
  }
}
