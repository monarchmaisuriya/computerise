import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { modeSchema, panelStatusRpc, setModeRpc, type Mode } from "../shared/contracts";
import type { ApprovalNotices } from "./approval-notices";

const LABEL: Record<Mode, string> = { off: "Computer off", ask: "Computer asks", auto: "Computer auto" };
const CHOICE: Record<Mode, string> = { off: "Off", ask: "Ask before actions", auto: "Automatic" };

const title = (count: number) => (count === 1 ? "Computer-use mode for this workspace's chat" : `Computer-use mode for all ${count} chats in this workspace`);
const label = (modes: readonly Mode[]) => (modes.every((mode) => mode === modes[0]) ? LABEL[modes[0]] : "Computer mixed");

type Shown = { registration: PluginButtonRegistration; chatIds: string[]; label: string };

// Paseo gives a header button its workspace but not the chat in front, so the header sets the mode
// of every chat in the workspace that has the computer tools. One 2-second poll keeps each
// workspace's button current and raises a notice for each approval waiting on the user.
export function contributeModeHeader(client: PluginClientContext, notices: ApprovalNotices) {
  const buttons = new Map<string, Shown>();
  const chats = new Map<string, { id: string; workspaceId: string; title: string }>();
  const lifetime = new AbortController();
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let removeObserver: (() => void) | undefined;
  let releaseSubscription: (() => Promise<void>) | undefined;
  let failing = false;

  const setAll = (workspaceId: string, mode: Mode) => async () => {
    const chatIds = buttons.get(workspaceId)?.chatIds ?? [];
    const results = await Promise.allSettled(chatIds.map((agentId) => client.rpc(setModeRpc, { agentId, mode })));
    refreshNow();
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed) throw new Error(`Could not set ${CHOICE[mode]} for ${failed} of ${chatIds.length} chats`);
  };
  const menu = (workspaceId: string, count: number): PluginButton["behavior"] => ({
    kind: "menu",
    items: modeSchema.options.map((mode) => ({
      kind: "item",
      id: mode,
      title: count === 1 ? CHOICE[mode] : `${CHOICE[mode]} for all ${count} chats`,
      behavior: { kind: "action", onPress: setAll(workspaceId, mode) },
    })),
  });

  const refresh = async () => {
    if (disposed) return;
    const status = await client.rpc(panelStatusRpc, {});
    const workspaces = new Map<string, { chatIds: string[]; modes: Mode[] }>();
    for (const chat of chats.values()) {
      if (!Object.hasOwn(status.modes, chat.id)) continue;
      const group = workspaces.get(chat.workspaceId) ?? { chatIds: [], modes: [] };
      group.chatIds.push(chat.id);
      group.modes.push(status.modes[chat.id]);
      workspaces.set(chat.workspaceId, group);
    }
    for (const [workspaceId, shown] of buttons) {
      if (workspaces.has(workspaceId)) continue;
      shown.registration.remove();
      buttons.delete(workspaceId);
    }
    for (const [workspaceId, { chatIds, modes }] of workspaces) {
      const text = { title: title(chatIds.length), label: label(modes) };
      const shown = buttons.get(workspaceId);
      if (!shown) {
        const button: PluginButton = { ...text, icon: "MonitorCog", behavior: menu(workspaceId, chatIds.length) };
        buttons.set(workspaceId, { registration: client.addHeaderButton({ id: "computer-mode", workspaceId, button }), chatIds, label: text.label });
        continue;
      }
      // Paseo closes an open menu on any update that carries a behavior. The menu's titles depend
      // only on the chat count, so it is resent only when that changes.
      if (shown.chatIds.length !== chatIds.length) shown.registration.update({ ...text, behavior: menu(workspaceId, chatIds.length) });
      else if (shown.label !== text.label) shown.registration.update(text);
      shown.chatIds = chatIds;
      shown.label = text.label;
    }
    notices.update(status.pending, (agentId) => chats.get(agentId)?.title ?? agentId);
  };
  // Refreshes run every 2 seconds, so a lost connection is reported once, not on every attempt.
  function refreshNow() {
    void refresh().then(
      () => {
        failing = false;
      },
      (error: unknown) => {
        if (!disposed && !failing) console.error("Computerise could not refresh the header controls", error);
        failing = true;
      },
    );
  }
  void client.paseo.agents.list({ subscribe: {}, includeBackground: true, page: { limit: 200 }, signal: lifetime.signal }).then(({ subscription }) => {
    releaseSubscription = () => subscription.release();
    removeObserver = subscription.subscribe({
      snapshot({ entries }) {
        chats.clear();
        for (const { agent } of entries) if (agent.workspaceId) chats.set(agent.id, { id: agent.id, workspaceId: agent.workspaceId, title: agent.title ?? agent.id });
        refreshNow();
      },
      update(message) {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert" && update.agent.workspaceId) chats.set(update.agent.id, { id: update.agent.id, workspaceId: update.agent.workspaceId, title: update.agent.title ?? update.agent.id });
        else if (update.kind === "remove") chats.delete(update.agentId);
        refreshNow();
      },
    });
    timer = setInterval(refreshNow, 2_000);
  }).catch((error: unknown) => !disposed && console.error("Computerise could not observe agents", error));

  return () => {
    disposed = true;
    lifetime.abort();
    if (timer) clearInterval(timer);
    removeObserver?.();
    void releaseSubscription?.().catch(() => undefined);
    for (const shown of buttons.values()) shown.registration.remove();
    buttons.clear();
    chats.clear();
  };
}
