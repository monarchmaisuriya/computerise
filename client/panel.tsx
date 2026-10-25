import { type PluginWorkspacePanelProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { answerApprovalRpc, type ApprovalScope, panelHealthRpc, panelScreenshotRpc, panelStatusRpc, type ScreenRecording, setModeRpc, setStopRpc, type Mode } from "../shared/contracts";
import { errorText } from "./errors";

function modeLabel(mode: Mode): string {
  return mode === "off" ? "Off" : mode === "ask" ? "Ask before actions" : "Automatic";
}

function screenRecordingLabel(state: ScreenRecording): string {
  return state === "granted" ? "granted" : state === "missing" ? "missing: grant it to Paseo, then reopen Paseo" : "not checked until the first screenshot";
}

export function ComputerPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const status = useRpc(panelStatusRpc);
  const image = useRpc(panelScreenshotRpc);
  const healthRpc = useRpc(panelHealthRpc);
  const setMode = useRpc(setModeRpc);
  const setStop = useRpc(setStopRpc);
  const answer = useRpc(answerApprovalRpc);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["computerise-panel"], queryFn: () => status({}), refetchInterval: 2_000 });
  // Its own query, so a long engine call never holds back the controls above.
  const healthQuery = useQuery({ queryKey: ["computerise-panel-health"], queryFn: () => healthRpc({}), refetchInterval: 5_000 });
  const health = healthQuery.data;
  const shotId = query.data?.screenshot?.id ?? null;
  const shotQuery = useQuery({ queryKey: ["computerise-panel-shot", shotId], queryFn: () => image({ id: shotId as string }), enabled: shotId !== null, staleTime: Infinity });
  const agentQuery = useQuery({ queryKey: ["computerise-panel-agents", workspaceId], queryFn: () => paseo.agents.list({ page: { limit: 200 } }) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["computerise-panel"] });
  const stop = useMutation({ mutationFn: (stopped: boolean) => setStop({ stopped }), onSuccess: refresh });
  const decide = useMutation({ mutationFn: (input: { requestId: string; agentId: string; allow: boolean; scope: ApprovalScope }) => answer(input), onSuccess: refresh });
  const change = useMutation({ mutationFn: ({ agentId, mode }: { agentId: string; mode: Mode }) => setMode({ agentId, mode }), onSuccess: refresh });
  const styles = {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 } as const,
    content: { padding: layout.compact ? 14 : 22, gap: 14 } as const,
    title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" as const },
    heading: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
    text: { color: theme.colors.foreground } as const,
    muted: { color: theme.colors.foregroundMuted } as const,
    card: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 12, gap: 8, backgroundColor: theme.colors.surface1 } as const,
    row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
  };
  const button = (label: string, onPress: () => void, primary = false, disabled = false) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={{ borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, opacity: disabled ? 0.55 : 1, backgroundColor: primary ? theme.colors.accent : theme.colors.surface2 }}>
      <Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
  if (query.isPending) return <View style={[styles.screen, styles.content]}><Text style={styles.muted}>Loading computer status</Text></View>;
  if (query.error) return <View style={[styles.screen, styles.content]}><Text style={{ color: theme.colors.statusDanger }}>{errorText(query.error)}</Text></View>;
  const data = query.data;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Computer</Text>
      <View style={styles.card}>
        <Text style={styles.heading}>{data.stopped ? "Stopped" : "Ready"}</Text>
        <Text style={styles.muted}>{data.holder ? `Screen lease: ${data.holder}` : "No agent is using the screen"}</Text>
        {!health ? (
          <Text style={styles.muted}>{healthQuery.error ? `Permissions: ${errorText(healthQuery.error)}` : "Checking permissions"}</Text>
        ) : (
          <>
            {health.engineError ? (
              <Text style={{ color: theme.colors.statusDanger }}>Engine: {health.engineError}</Text>
            ) : (
              <Text style={health.accessibility === "missing" ? { color: theme.colors.statusWarning } : styles.muted}>Accessibility: {health.accessibility === "missing" ? "missing: grant it to Paseo" : "granted"}</Text>
            )}
            <Text style={health.screenRecording === "missing" ? { color: theme.colors.statusWarning } : styles.muted}>Screen Recording: {screenRecordingLabel(health.screenRecording)}</Text>
          </>
        )}
        <View style={styles.row}>
          {data.stopped ? button("Resume computer use", () => stop.mutate(false), true, stop.isPending) : button("Stop all computer use", () => stop.mutate(true), true, stop.isPending)}
          {button("Refresh", () => void query.refetch(), false, query.isFetching)}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Agents</Text>
        {agentQuery.isPending && <Text style={styles.muted}>Loading agents</Text>}
        {agentQuery.data?.entries.filter(({ agent }) => agent.workspaceId === workspaceId).length === 0 && <Text style={styles.muted}>No agents in this workspace.</Text>}
        {agentQuery.data?.entries.filter(({ agent }) => agent.workspaceId === workspaceId).map(({ agent }) => {
          const mode = data.modes[agent.id] ?? "off";
          return <View key={agent.id} style={{ gap: 6 }}>
            <Text style={styles.text}>{agent.title ?? agent.id}: {modeLabel(mode)}</Text>
            <View style={styles.row}>
              {(["off", "ask", "auto"] as const).map((choice) => button(modeLabel(choice), () => change.mutate({ agentId: agent.id, mode: choice }), mode === choice, change.isPending))}
            </View>
          </View>;
        })}
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Pending approvals</Text>
        {data.pending.length === 0 && <Text style={styles.muted}>No computer actions are waiting.</Text>}
        {data.pending.map((pending) => (
          <View key={pending.requestId} style={{ gap: 6 }}>
            <Text style={styles.text}>{pending.action}</Text>
            <Text style={styles.muted}>{pending.app} · {pending.agentId}</Text>
            <View style={styles.row}>
              {button("Allow", () => decide.mutate({ requestId: pending.requestId, agentId: pending.agentId, allow: true, scope: "once" }), true, decide.isPending)}
              {pending.appScope !== null && button(`Allow ${pending.appScope} this turn`, () => decide.mutate({ requestId: pending.requestId, agentId: pending.agentId, allow: true, scope: "app-for-turn" }), false, decide.isPending)}
              {button("Deny", () => decide.mutate({ requestId: pending.requestId, agentId: pending.agentId, allow: false, scope: "once" }), false, decide.isPending)}
            </View>
          </View>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Last screenshot</Text>
        {data.screenshot ? (
          <>
            {shotQuery.data?.id === data.screenshot.id ? (
              <Image accessibilityLabel="Last computer screenshot" resizeMode="contain" source={{ uri: `data:image/jpeg;base64,${shotQuery.data.jpegBase64}` }} style={{ width: "100%", aspectRatio: data.screenshot.width / data.screenshot.height, backgroundColor: theme.colors.surface2, borderRadius: 8 }} />
            ) : (
              <Text style={shotQuery.error ? { color: theme.colors.statusWarning } : styles.muted}>{shotQuery.error ? errorText(shotQuery.error) : "Loading screenshot"}</Text>
            )}
            <Text style={styles.muted}>{data.screenshot.width} × {data.screenshot.height} · {data.screenshot.agentId}</Text>
          </>
        ) : <Text style={styles.muted}>No agent has taken a screenshot yet.</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Recent actions</Text>
        {data.recent.length === 0 && <Text style={styles.muted}>No computer tool calls yet.</Text>}
        {data.recent.map((entry, index) => <Text key={`${entry.time}-${index}`} style={entry.outcome === "ok" ? styles.text : { color: theme.colors.statusWarning }}>{entry.tool}{entry.chars !== undefined ? ` (${entry.chars} characters)` : ""}: {entry.outcome}</Text>)}
      </View>
      {(stop.error || decide.error || change.error) && <Text style={{ color: theme.colors.statusDanger }}>{errorText(stop.error ?? decide.error ?? change.error)}</Text>}
    </ScrollView>
  );
}
