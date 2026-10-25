import { randomUUID } from "node:crypto";
import type { ApprovalRow, ApprovalStatus } from "../shared/contracts";

export type Decision = "allow" | "deny" | "timeout" | "cancelled";

// Shows a row in the agent's chat; showing again with the same rowId replaces it.
export interface ApprovalRows {
  show(agentId: string, rowId: string, row: ApprovalRow): Promise<void>;
}

const STATUS: Record<Decision, ApprovalStatus> = { allow: "allowed", deny: "denied", timeout: "timed out", cancelled: "cancelled" };

type Pending = { agentId: string; rowId: string; row: ApprovalRow; shown: Promise<void>; resolve: (decision: Decision) => void; timer: NodeJS.Timeout | null };

// Approvals are owned by the plugin, not by each agent CLI, so they hold whatever permission mode
// the CLI runs in.
export class Approvals {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly rows: ApprovalRows,
    private readonly timeoutMs: () => Promise<number>,
  ) {}

  async request(agentId: string, action: string, app: string): Promise<Decision> {
    const timeoutMs = await this.timeoutMs();
    const requestId = randomUUID();
    const rowId = `approval-${requestId}`;
    const row: ApprovalRow = { requestId, action, app, status: "pending" };
    let resolveDecision!: (decision: Decision) => void;
    const decision = new Promise<Decision>((resolve) => {
      resolveDecision = resolve;
    });
    const shown = this.rows.show(agentId, rowId, row);
    this.pending.set(requestId, { agentId, rowId, row, shown, resolve: resolveDecision, timer: null });
    try {
      await shown;
      const pending = this.pending.get(requestId);
      if (pending) pending.timer = setTimeout(() => this.finish(requestId, "timeout"), timeoutMs);
    } catch (error) {
      const timer = this.pending.get(requestId)?.timer;
      if (timer) clearTimeout(timer);
      this.pending.delete(requestId);
      throw new Error(`Could not ask the user: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return decision;
  }

  answer(requestId: string, agentId: string, allow: boolean): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`No pending approval ${requestId}`);
    if (pending.agentId !== agentId) throw new Error(`Approval ${requestId} belongs to another agent`);
    this.finish(requestId, allow ? "allow" : "deny");
  }

  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.finish(requestId, "cancelled");
  }

  listPending(): Array<ApprovalRow & { agentId: string }> {
    return [...this.pending.values()].map(({ agentId, row }) => ({ agentId, ...row }));
  }

  private finish(requestId: string, decision: Decision): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(decision);
    pending.shown
      .then(() => this.rows.show(pending.agentId, pending.rowId, { ...pending.row, status: STATUS[decision] }))
      .catch((error: unknown) => console.error(`[computerise] could not mark approval ${requestId} ${STATUS[decision]}: ${String(error)}`));
  }
}
