import { type PluginTimelineItemProps, useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { answerApprovalRpc, type ApprovalScope, type approvalRowSchema } from "../shared/contracts";
import { errorText } from "./errors";

type Data = z.infer<typeof approvalRowSchema>;

export function ApprovalRow({ agentId, item, theme }: PluginTimelineItemProps<Data>) {
  const answer = useRpc(answerApprovalRpc);
  const decision = useMutation({ mutationFn: ({ allow, scope }: { allow: boolean; scope: ApprovalScope }) => answer({ requestId: item.data.requestId, agentId, allow, scope }) });
  const pending = item.data.status === "pending";
  const button = (label: string, allow: boolean, primary: boolean, scope: ApprovalScope = "once") => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} computer action: ${item.data.action}`}
      disabled={!pending || decision.isPending}
      onPress={() => decision.mutate({ allow, scope })}
      style={{ borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, opacity: pending ? 1 : 0.6, backgroundColor: primary ? theme.colors.accent : theme.colors.surface2 }}
    >
      <Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 12, gap: 8, backgroundColor: theme.colors.surface1 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Computer action</Text>
      <Text style={{ color: theme.colors.foreground }}>{item.data.action}</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>Target: {item.data.app} · {item.data.status}</Text>
      {pending && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {button("Allow", true, true)}
          {item.data.appScope !== null && button(`Allow ${item.data.appScope} this turn`, true, false, "app-for-turn")}
          {button("Deny", false, false)}
        </View>
      )}
      {decision.error && <Text style={{ color: theme.colors.statusDanger }}>{errorText(decision.error)}</Text>}
    </View>
  );
}
