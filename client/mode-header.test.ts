import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Mode, panelStatusRpc } from "../shared/contracts";
import { ApprovalNotices } from "./approval-notices";
import { contributeModeHeader } from "./mode-header";

type Observer = { snapshot(page: unknown): void; update(message: unknown): void };
type Chat = { id: string; workspaceId: string; title: string };
type Item = { title: string; icon?: string; behavior: { onPress(): Promise<void> } };
type Header = { workspaceId: string; button: Record<string, unknown>; updates: Record<string, unknown>[]; removed: boolean };

// A stand-in for the Paseo client: the status RPC answers from modes, header buttons record their updates.
// It has no addComposerPill, so a composer pill would fail the test.
function fakeClient(modes: Record<string, Mode>) {
  const headers: Header[] = [];
  const state = { failing: false, failSet: new Set<string>(), observer: null as Observer | null, listOptions: null as unknown, pending: [] as { requestId: string; agentId: string; action: string }[] };
  const client = {
    rpc: async (contract: unknown, input: { agentId: string; mode: Mode }) => {
      if (state.failing) throw new Error("Transport not connected");
      if (contract === panelStatusRpc) return { modes: { ...modes }, pending: state.pending };
      if (state.failSet.has(input.agentId)) throw new Error("agent closed");
      modes[input.agentId] = input.mode;
      return { mode: input.mode };
    },
    addHeaderButton: (contribution: { id: string; workspaceId: string; button: Record<string, unknown> }) => {
      const header: Header = { workspaceId: contribution.workspaceId, button: contribution.button, updates: [], removed: false };
      headers.push(header);
      return { update: (patch: Record<string, unknown>) => header.updates.push(patch), remove: () => (header.removed = true) };
    },
    paseo: {
      agents: {
        list: async (options: unknown) => {
          state.listOptions = options;
          return {
          subscription: {
            subscribe: (observer: Observer) => {
              state.observer = observer;
              return () => undefined;
            },
            release: async () => undefined,
          },
        };
        },
      },
    },
  } as unknown as PluginClientContext;
  const upsert = (chat: Chat) => state.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: chat } });
  const removeChat = (agentId: string) => state.observer?.update({ type: "agent_update", payload: { kind: "remove", agentId } });
  return { client, headers, state, modes, upsert, removeChat };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const slack: Chat = { id: "agent-1", workspaceId: "ws-1", title: "Slack thread check" };
const notes: Chat = { id: "agent-2", workspaceId: "ws-1", title: "Notes cleanup" };
const other: Chat = { id: "agent-3", workspaceId: "ws-2", title: "Other workspace" };

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.restoreAllMocks();
});

async function started(modes: Record<string, Mode>, chats: Chat[]) {
  const fake = fakeClient(modes);
  const notified: string[][] = [];
  dispose = contributeModeHeader(fake.client, new ApprovalNotices((title, body) => notified.push([title, body])));
  await settle();
  fake.state.observer?.snapshot({ entries: chats.map((agent) => ({ agent })) });
  await settle();
  return { ...fake, notified };
}

const items = (header: Header) => (header.button.behavior as { items: Item[] }).items;
const live = (fake: { headers: Header[] }) => fake.headers.filter((header) => !header.removed);

describe("the workspace header mode button", () => {
  it("shows one chat's mode in its workspace header, with the three modes in its menu", async () => {
    const fake = await started({ "agent-1": "ask" }, [slack]);
    expect(live(fake)).toHaveLength(1);
    expect(fake.headers[0]).toMatchObject({ workspaceId: "ws-1", button: { label: "Computer asks", icon: "MonitorCog", behavior: { kind: "menu" } } });
    expect(items(fake.headers[0]).map((item) => item.title)).toEqual(["Off", "Ask before actions", "Automatic"]);
  });

  // Paseo focuses the first row when a menu opens, which looks like a selection; the check shows
  // the mode the chats are actually in.
  it("checks the mode the workspace's chats share, and no mode while they differ", async () => {
    const fake = await started({ "agent-1": "ask", "agent-2": "off", "agent-3": "auto" }, [slack, notes, other]);
    const [ws1, ws2] = live(fake);
    expect(items(ws1).map((item) => item.icon ?? null)).toEqual([null, null, null]);
    expect(items(ws2).map((item) => item.icon ?? null)).toEqual([null, null, "Check"]);
  });

  // Paseo closes an open header menu whenever an update carries a behavior, so a refresh that finds
  // nothing new must not touch the button.
  it("leaves the button alone while nothing changes, so an open menu stays open", async () => {
    const fake = await started({ "agent-1": "ask" }, [slack]);
    fake.upsert(slack);
    await settle();
    fake.upsert(slack);
    await settle();
    expect(fake.headers[0].updates).toEqual([]);
  });

  it("reads mixed when a workspace's chats differ, and one pick sets every chat in that workspace only", async () => {
    const fake = await started({ "agent-1": "ask", "agent-2": "off", "agent-3": "off" }, [slack, notes, other]);
    const [ws1, ws2] = live(fake);
    expect(ws1).toMatchObject({ workspaceId: "ws-1", button: { label: "Computer mixed", title: "Computer-use mode for all 2 chats in this workspace" } });
    expect(items(ws1).map((item) => item.title)).toEqual(["Off for all 2 chats", "Ask before actions for all 2 chats", "Automatic for all 2 chats"]);
    await items(ws1)[2].behavior.onPress();
    await settle();
    expect(fake.modes).toEqual({ "agent-1": "auto", "agent-2": "auto", "agent-3": "off" });
    expect(ws1.updates).toHaveLength(1);
    const update = ws1.updates[0] as { title: string; label: string; behavior: { items: Item[] } };
    expect(update).toMatchObject({ title: "Computer-use mode for all 2 chats in this workspace", label: "Computer auto" });
    expect(update.behavior.items.map((item) => item.icon ?? null)).toEqual([null, null, "Check"]);
    expect(ws2.updates).toEqual([]);
  });

  // Paseo hides background agents (for example a child created with background: true) from agent
  // lists unless asked, and they get the computer tools like any other chat in the workspace.
  it("lists background chats too, so a pick reaches every chat in the workspace", async () => {
    const fake = await started({ "agent-1": "ask" }, [slack]);
    expect(fake.state.listOptions).toMatchObject({ includeBackground: true });
  });

  it("leaves out chats without the computer tools, so a pick never gives them a mode", async () => {
    const fake = await started({ "agent-1": "ask" }, [slack, notes]);
    expect(fake.headers[0].button).toMatchObject({ label: "Computer asks", title: "Computer-use mode for this workspace's chat" });
    await items(fake.headers[0])[2].behavior.onPress();
    expect(fake.modes).toEqual({ "agent-1": "auto" });
  });

  it("reports how many chats it could not set, after setting the rest", async () => {
    const fake = await started({ "agent-1": "ask", "agent-2": "ask" }, [slack, notes]);
    fake.state.failSet.add("agent-2");
    await expect(items(fake.headers[0])[0].behavior.onPress()).rejects.toThrow("Could not set Off for 1 of 2 chats");
    expect(fake.modes["agent-1"]).toBe("off");
  });

  it("resends the menu only when the chat count or the shared mode changes", async () => {
    const fake = await started({ "agent-1": "ask", "agent-2": "ask" }, [slack]);
    fake.upsert(notes);
    await settle();
    expect(fake.headers[0].updates).toHaveLength(1);
    const update = fake.headers[0].updates[0] as { label: string; behavior: { items: Item[] } };
    expect(update.label).toBe("Computer asks");
    expect(update.behavior.items.map((item) => item.title)).toContain("Automatic for all 2 chats");
  });

  it("removes the button when the workspace's last chat goes", async () => {
    const fake = await started({ "agent-1": "ask" }, [slack]);
    fake.removeChat("agent-1");
    await settle();
    expect(live(fake)).toEqual([]);
  });

  it("notifies about a waiting approval once, naming the agent's chat", async () => {
    const fake = await started({ "agent-1": "ask" }, [slack]);
    fake.state.pending = [{ requestId: "r1", agentId: "agent-1", action: "open Slack (com.tinyspeck.slackmacgap)" }];
    fake.upsert(slack);
    await settle();
    fake.upsert(slack);
    await settle();
    expect(fake.notified).toEqual([["Computer action waiting", "Slack thread check: open Slack (com.tinyspeck.slackmacgap)"]]);
  });

  it("reports a failed refresh once until a refresh succeeds again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = await started({ "agent-1": "ask" }, [slack]);
    fake.state.failing = true;
    fake.upsert(slack);
    await settle();
    fake.upsert(slack);
    await settle();
    expect(error).toHaveBeenCalledTimes(1);
    fake.state.failing = false;
    fake.upsert(slack);
    await settle();
    fake.state.failing = true;
    fake.upsert(slack);
    await settle();
    expect(error).toHaveBeenCalledTimes(2);
  });
});
