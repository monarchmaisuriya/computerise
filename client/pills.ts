import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { panelStatusRpc, setModeRpc, type Mode } from "../shared/contracts";
import type { ApprovalNotices } from "./approval-notices";

function label(mode: Mode): string {
  return mode === "off" ? "Computer off" : mode === "ask" ? "Computer asks" : "Computer auto";
}

// One 2-second poll keeps each agent's mode pill current and raises a notice for each approval
// waiting on the user.
export function contributePills(client: PluginClientContext, notices: ApprovalNotices) {
  const pills = new Map<string, { registration: PluginButtonRegistration; mode: Mode }>();
  const agents = new Map<string, { id: string; workspaceId: string; title: string }>();
  const lifetime = new AbortController();
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let removeObserver: (() => void) | undefined;
  let releaseSubscription: (() => Promise<void>) | undefined;
  let failing = false;

  const refresh = async () => {
    if (disposed) return;
    const status = await client.rpc(panelStatusRpc, {});
    for (const agent of agents.values()) {
      if (!Object.hasOwn(status.modes, agent.id)) {
        pills.get(agent.id)?.registration.remove();
        pills.delete(agent.id);
        continue;
      }
      const mode = status.modes[agent.id];
      const text = { title: `${label(mode)}. Choose computer-use mode`, label: label(mode) };
      const existing = pills.get(agent.id);
      // Paseo closes an open pill menu on any update that carries a behavior, so the menu is sent
      // once and later updates change only the text, and only when the mode changed.
      if (existing) {
        if (existing.mode !== mode) existing.registration.update(text);
        existing.mode = mode;
        continue;
      }
      const set = (next: Mode) => async () => {
        await client.rpc(setModeRpc, { agentId: agent.id, mode: next });
        await refresh();
      };
      const button = {
        ...text,
        icon: "MonitorCog" as const,
        behavior: {
          kind: "menu" as const,
          items: (["off", "ask", "auto"] as const).map((next) => ({ kind: "item" as const, id: next, title: next === "off" ? "Off" : next === "ask" ? "Ask before actions" : "Automatic", behavior: { kind: "action" as const, onPress: set(next) } })),
        },
      };
      pills.set(agent.id, { registration: client.addComposerPill({ id: "computer-mode", workspaceId: agent.workspaceId, agentId: agent.id, button }), mode });
    }
    notices.update(status.pending, (agentId) => agents.get(agentId)?.title ?? agentId);
  };
  // Refreshes run every 2 seconds, so a lost connection is reported once, not on every attempt.
  const refreshNow = () =>
    void refresh().then(
      () => {
        failing = false;
      },
      (error: unknown) => {
        if (!disposed && !failing) console.error("Computerise could not refresh the composer controls", error);
        failing = true;
      },
    );
  const remove = (agentId: string) => {
    agents.delete(agentId);
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  };
  void client.paseo.agents.list({ subscribe: {}, page: { limit: 200 }, signal: lifetime.signal }).then(({ subscription }) => {
    releaseSubscription = () => subscription.release();
    removeObserver = subscription.subscribe({
      snapshot({ entries }) {
        for (const agentId of [...agents.keys()]) remove(agentId);
        for (const { agent } of entries) if (agent.workspaceId) agents.set(agent.id, { id: agent.id, workspaceId: agent.workspaceId, title: agent.title ?? agent.id });
        refreshNow();
      },
      update(message) {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert" && update.agent.workspaceId) agents.set(update.agent.id, { id: update.agent.id, workspaceId: update.agent.workspaceId, title: update.agent.title ?? update.agent.id });
        else if (update.kind === "remove") remove(update.agentId);
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
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
    agents.clear();
  };
}
