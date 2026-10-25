import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { setModeRpc, statusRpc, type Mode } from "../shared/contracts";

function label(mode: Mode): string {
  return mode === "off" ? "Computer off" : mode === "ask" ? "Computer asks" : "Computer auto";
}

export function contributePills(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const agents = new Map<string, { id: string; workspaceId: string }>();
  const lifetime = new AbortController();
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let removeObserver: (() => void) | undefined;
  let releaseSubscription: (() => Promise<void>) | undefined;

  const refresh = async () => {
    if (disposed) return;
    const status = await client.rpc(statusRpc, {});
    for (const agent of agents.values()) {
      const mode = status.modes[agent.id] ?? "off";
      const set = (next: Mode) => async () => {
        await client.rpc(setModeRpc, { agentId: agent.id, mode: next });
        await refresh();
      };
      const button = {
        title: `${label(mode)}. Choose computer-use mode`,
        label: label(mode),
        icon: "MonitorCog" as const,
        behavior: {
          kind: "menu" as const,
          items: (["off", "ask", "auto"] as const).map((next) => ({ kind: "item" as const, id: next, title: next === "off" ? "Off" : next === "ask" ? "Ask before actions" : "Automatic", behavior: { kind: "action" as const, onPress: set(next) } })),
        },
      };
      const existing = pills.get(agent.id);
      if (existing) existing.update(button);
      else pills.set(agent.id, client.addComposerPill({ id: "computer-mode", workspaceId: agent.workspaceId, agentId: agent.id, button }));
    }
  };
  const remove = (agentId: string) => {
    agents.delete(agentId);
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };
  void client.paseo.agents.list({ subscribe: {}, page: { limit: 200 }, signal: lifetime.signal }).then(({ subscription }) => {
    releaseSubscription = () => subscription.release();
    removeObserver = subscription.subscribe({
      snapshot({ entries }) {
        for (const agentId of [...agents.keys()]) remove(agentId);
        for (const { agent } of entries) if (agent.workspaceId) agents.set(agent.id, { id: agent.id, workspaceId: agent.workspaceId });
        void refresh();
      },
      update(message) {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert" && update.agent.workspaceId) agents.set(update.agent.id, { id: update.agent.id, workspaceId: update.agent.workspaceId });
        else if (update.kind === "remove") remove(update.agentId);
        void refresh();
      },
    });
    timer = setInterval(() => void refresh().catch(() => undefined), 2_000);
  }).catch((error: unknown) => !disposed && console.error("Computerise could not observe agents", error));

  return () => {
    disposed = true;
    lifetime.abort();
    if (timer) clearInterval(timer);
    removeObserver?.();
    void releaseSubscription?.().catch(() => undefined);
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    agents.clear();
  };
}
