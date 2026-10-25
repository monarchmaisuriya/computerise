import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRow } from "../shared/contracts";
import { Approvals } from "./approvals";

function fakeRows() {
  const shown: { agentId: string; rowId: string; row: ApprovalRow }[] = [];
  return {
    shown,
    rows: { show: async (agentId: string, rowId: string, row: ApprovalRow) => void shown.push({ agentId, rowId, row }) },
    latest: () => shown[shown.length - 1],
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("approvals", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows a pending row and resolves allow or deny when the user answers, updating the same row", async () => {
    const rows = fakeRows();
    const approvals = new Approvals(rows.rows, async () => 45_000);
    const decision = approvals.request("agent-x", "click left at (400, 220)", "TextEdit");
    await settle();
    const pending = rows.latest();
    expect(pending.agentId).toBe("agent-x");
    expect(pending.row).toMatchObject({ action: "click left at (400, 220)", app: "TextEdit", status: "pending" });
    approvals.answer(pending.row.requestId, "agent-x", true);
    expect(await decision).toBe("allow");
    await settle();
    expect(rows.latest()).toMatchObject({ rowId: pending.rowId, row: { status: "allowed" } });

    const denied = approvals.request("agent-x", "type 5 characters", "TextEdit");
    await settle();
    approvals.answer(rows.latest().row.requestId, "agent-x", false);
    expect(await denied).toBe("deny");
    await settle();
    expect(rows.latest().row.status).toBe("denied");
  });

  it("times out after the configured wait and marks the row", async () => {
    const rows = fakeRows();
    const approvals = new Approvals(rows.rows, async () => 5_000);
    const decision = approvals.request("agent-x", "key cmd+s", "TextEdit");
    await settle();
    vi.advanceTimersByTime(4_999);
    await settle();
    expect(rows.latest().row.status).toBe("pending");
    vi.advanceTimersByTime(1);
    expect(await decision).toBe("timeout");
    await settle();
    expect(rows.latest().row.status).toBe("timed out");
  });

  it("starts the timeout only after the approval row is visible", async () => {
    let showRow: (() => void) | undefined;
    const shown: ApprovalRow[] = [];
    const approvals = new Approvals(
      {
        show: async (_agentId, _rowId, row) => {
          shown.push(row);
          if (row.status === "pending") {
            await new Promise<void>((resolve) => {
              showRow = resolve;
            });
          }
        },
      },
      async () => 5_000,
    );
    const decision = approvals.request("agent-x", "click", "TextEdit");
    await settle();
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(shown.at(-1)?.status).toBe("pending");
    expect(approvals.listPending()).toHaveLength(1);

    showRow?.();
    await settle();
    vi.advanceTimersByTime(4_999);
    await settle();
    expect(approvals.listPending()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(await decision).toBe("timeout");
  });

  it("does not let a slow pending append overwrite cancellation", async () => {
    let showPending: (() => void) | undefined;
    const shown: ApprovalRow[] = [];
    const approvals = new Approvals(
      {
        show: async (_agentId, _rowId, row) => {
          if (row.status === "pending") {
            await new Promise<void>((resolve) => {
              showPending = resolve;
            });
          }
          shown.push(row);
        },
      },
      async () => 45_000,
    );
    const decision = approvals.request("agent-x", "click", "TextEdit");
    await settle();
    approvals.cancelAll();
    showPending?.();
    expect(await decision).toBe("cancelled");
    await settle();
    expect(shown.map((row) => row.status)).toEqual(["pending", "cancelled"]);
  });

  it("refuses an answer for an unknown request, another agent's request, or one already answered", async () => {
    const rows = fakeRows();
    const approvals = new Approvals(rows.rows, async () => 45_000);
    const decision = approvals.request("agent-x", "click", "TextEdit");
    await settle();
    const { requestId } = rows.latest().row;
    expect(() => approvals.answer("nope", "agent-x", true)).toThrow("No pending approval nope");
    expect(() => approvals.answer(requestId, "agent-y", true)).toThrow(`Approval ${requestId} belongs to another agent`);
    approvals.answer(requestId, "agent-x", false);
    expect(() => approvals.answer(requestId, "agent-x", true)).toThrow(`No pending approval ${requestId}`);
    expect(await decision).toBe("deny");
  });

  it("cancels every pending request when computer use is stopped", async () => {
    const rows = fakeRows();
    const approvals = new Approvals(rows.rows, async () => 45_000);
    const first = approvals.request("agent-x", "click", "TextEdit");
    const second = approvals.request("agent-y", "type", "Notes");
    await settle();
    expect(approvals.listPending()).toEqual([
      expect.objectContaining({ agentId: "agent-x", action: "click", app: "TextEdit" }),
      expect.objectContaining({ agentId: "agent-y", action: "type", app: "Notes" }),
    ]);
    approvals.cancelAll();
    expect(await first).toBe("cancelled");
    expect(await second).toBe("cancelled");
    expect(approvals.listPending()).toEqual([]);
  });

  it("fails the request when the row cannot be shown, since the user could not answer it", async () => {
    const approvals = new Approvals({ show: async () => Promise.reject(new Error("timeline closed")) }, async () => 45_000);
    await expect(approvals.request("agent-x", "click", "TextEdit")).rejects.toThrow("Could not ask the user: timeline closed");
  });
});
