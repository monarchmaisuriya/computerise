import { randomUUID } from "node:crypto";
import type { ApprovalRow, ApprovalScope, ApprovalStatus } from "../shared/contracts";
import type { AppRef } from "./policy";

export type Decision = "allow" | "allow-app" | "deny" | "timeout" | "cancelled";

// Shows a row in the agent's chat; showing again with the same rowId replaces it.
export interface ApprovalRows {
  show(agentId: string, rowId: string, row: ApprovalRow): Promise<void>;
}

const STATUS: Record<Decision, ApprovalStatus> = { allow: "allowed", "allow-app": "allowed", deny: "denied", timeout: "timed out", cancelled: "cancelled" };

type Pending = { agentId: string; rowId: string; row: ApprovalRow; shown: Promise<void>; resolve: (decision: Decision) => void; timer: NodeJS.Timeout | null };

// Approvals are owned by the plugin, not by each agent CLI, so they hold whatever permission mode
// the CLI runs in.
export class Approvals {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly rows: ApprovalRows,
    private readonly timeoutMs: () => Promise<number>,
  ) {}

  // appScope names the app the user may allow for the rest of the turn, or null when the action
  // must always ask.
  async request(agentId: string, action: string, app: string, appScope: string | null = null): Promise<Decision> {
    const timeoutMs = await this.timeoutMs();
    const requestId = randomUUID();
    const rowId = `approval-${requestId}`;
    const row: ApprovalRow = { requestId, action, app, status: "pending", appScope };
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

  answer(requestId: string, agentId: string, allow: boolean, scope: ApprovalScope = "once"): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`No pending approval ${requestId}`);
    if (pending.agentId !== agentId) throw new Error(`Approval ${requestId} belongs to another agent`);
    if (scope === "app-for-turn") {
      if (!allow) throw new Error("Only Allow can cover the whole app; Deny applies to this action");
      if (pending.row.appScope === null) throw new Error(`Approval ${requestId} is for an action that always asks`);
    }
    this.finish(requestId, !allow ? "deny" : scope === "app-for-turn" ? "allow-app" : "allow");
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

// Apps each agent may use pointer actions in without asking, until its turn ends. The plugin clears
// an agent's apps on turn end, close, archive, and any mode change, and every agent's on Stop.
export class ApprovalScopes {
  private readonly apps = new Map<string, Set<string>>();

  allow(agentId: string, bundleId: string): void {
    const apps = this.apps.get(agentId) ?? new Set<string>();
    apps.add(bundleId);
    this.apps.set(agentId, apps);
  }

  covers(agentId: string, receivers: readonly AppRef[]): boolean {
    const apps = this.apps.get(agentId);
    return apps !== undefined && receivers.length > 0 && receivers.every((app) => app.bundleId !== null && apps.has(app.bundleId));
  }

  clear(agentId: string): void {
    this.apps.delete(agentId);
  }

  clearAll(): void {
    this.apps.clear();
  }
}
