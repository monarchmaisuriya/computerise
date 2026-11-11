import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Mode, panelStatusRpc } from "../shared/contracts";
import { ApprovalNotices } from "./approval-notices";
import { contributePills } from "./pills";

type Observer = { snapshot(page: unknown): void; update(message: unknown): void };

// A stand-in for the Paseo client: the status RPC answers from modes, pills record their updates.
function fakeClient(modes: Record<string, Mode>) {
  const added: { agentId: string; button: Record<string, unknown> }[] = [];
  const updates: Record<string, unknown>[] = [];
  const state = { failing: false, observer: null as Observer | null, pending: [] as { requestId: string; agentId: string; action: string }[] };
  const client = {
    rpc: async (contract: unknown, input: { agentId: string; mode: Mode }) => {
      if (state.failing) throw new Error("Transport not connected");
      if (contract === panelStatusRpc) return { modes: { ...modes }, pending: state.pending };
      modes[input.agentId] = input.mode;
      return {};
    },
    addComposerPill: (contribution: { agentId: string; button: Record<string, unknown> }) => {
      added.push(contribution);
      return { update: (patch: Record<string, unknown>) => updates.push(patch), remove: () => undefined };
    },
    paseo: {
      agents: {
        list: async () => ({
          subscription: {
            subscribe: (observer: Observer) => {
              state.observer = observer;
              return () => undefined;
            },
            release: async () => undefined,
          },
        }),
      },
    },
  } as unknown as PluginClientContext;
  const agentUpdate = () => state.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: { id: "agent-1", workspaceId: "ws-1", title: "Slack thread check" } } });
  return { client, added, updates, state, agentUpdate };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.restoreAllMocks();
});

async function started(modes: Record<string, Mode>) {
  const fake = fakeClient(modes);
  const notified: string[][] = [];
  dispose = contributePills(fake.client, new ApprovalNotices((title, body) => notified.push([title, body])));
  await settle();
  fake.state.observer?.snapshot({ entries: [{ agent: { id: "agent-1", workspaceId: "ws-1", title: "Slack thread check" } }] });
  await settle();
  return { ...fake, notified };
}

describe("the composer mode pill", () => {
  // Paseo closes an open pill menu whenever an update carries a behavior, so a refresh that finds the
  // same mode must not touch the pill.
  it("leaves the pill alone while the mode is unchanged, so an open menu stays open", async () => {
    const fake = await started({ "agent-1": "ask" });
    expect(fake.added).toHaveLength(1);
    expect(fake.added[0].button).toMatchObject({ label: "Computer asks", behavior: { kind: "menu" } });
    fake.agentUpdate();
    fake.agentUpdate();
    await settle();
    expect(fake.updates).toEqual([]);
  });

  it("changes only the title and label when the mode changes, never the menu", async () => {
    const fake = await started({ "agent-1": "ask" });
    const items = (fake.added[0].button.behavior as { items: { behavior: { onPress(): Promise<void> } }[] }).items;
    await items[2].behavior.onPress();
    await settle();
    expect(fake.updates).toEqual([{ title: "Computer auto. Choose computer-use mode", label: "Computer auto" }]);
  });

  it("notifies about a waiting approval once, naming the agent's chat", async () => {
    const fake = await started({ "agent-1": "ask" });
    fake.state.pending = [{ requestId: "r1", agentId: "agent-1", action: "open Slack (com.tinyspeck.slackmacgap)" }];
    fake.agentUpdate();
    await settle();
    fake.agentUpdate();
    await settle();
    expect(fake.notified).toEqual([["Computer action waiting", "Slack thread check: open Slack (com.tinyspeck.slackmacgap)"]]);
  });

  it("reports a failed refresh once until a refresh succeeds again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = await started({ "agent-1": "ask" });
    fake.state.failing = true;
    fake.agentUpdate();
    await settle();
    fake.agentUpdate();
    await settle();
    expect(error).toHaveBeenCalledTimes(1);
    fake.state.failing = false;
    fake.agentUpdate();
    await settle();
    fake.state.failing = true;
    fake.agentUpdate();
    await settle();
    expect(error).toHaveBeenCalledTimes(2);
  });
});
