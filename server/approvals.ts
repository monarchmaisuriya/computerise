import { randomUUID } from "node:crypto";
import type { ApprovalRow, ApprovalStatus } from "../shared/contracts";

export type Decision = "allow" | "deny" | "timeout" | "cancelled";

// Shows a row in the agent's chat; showing again with the same rowId replaces it.
export interface ApprovalRows {
  show(agentId: string, rowId: string, row: ApprovalRow): Promise<void>;
}

const STATUS: Record<Decision, ApprovalStatus> = { allow: "allowed", deny: "denied", timeout: "timed out", cancelled: "cancelled" };

type Pending = { agentId: string; rowId: string; row: ApprovalRow; resolve: (decision: Decision) => void; timer: NodeJS.Timeout };

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
    const decision = new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => this.finish(requestId, "timeout"), timeoutMs);
      this.pending.set(requestId, { agentId, rowId, row, resolve, timer });
    });
    try {
      await this.rows.show(agentId, rowId, row);
    } catch (error) {
      clearTimeout(this.pending.get(requestId)?.timer);
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
    clearTimeout(pending.timer);
    pending.resolve(decision);
    this.rows
      .show(pending.agentId, pending.rowId, { ...pending.row, status: STATUS[decision] })
      .catch((error: unknown) => console.error(`[computerise] could not mark approval ${requestId} ${STATUS[decision]}: ${String(error)}`));
  }
}
