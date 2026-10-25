import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ApprovalRow } from "./client/approval-row";
import { parseComputerCommand } from "./client/commands";
import { ComputerPanel } from "./client/panel";
import { contributePills } from "./client/pills";
import { ComputerSettingsScreen } from "./client/settings-screen";
import { APPROVAL_ROW_KIND, approvalRowSchema, setModeRpc, setStopRpc, statusRpc } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const removers = [
    contributePills(client),
    client.addWorkspacePanel({ id: "computer", title: "Computer", icon: "MonitorCog", locations: ["workspace", "explorer"], Component: ComputerPanel }),
    client.addSettingsScreen({ id: "computer", title: "Computerise", icon: "MonitorCog", Component: ComputerSettingsScreen }),
    client.addTimelineRenderer({ kind: APPROVAL_ROW_KIND, version: 1, schema: approvalRowSchema, Component: ApprovalRow }),
    client.addSlashCommand({
      name: "computer",
      description: "Turn computer use off, ask before actions, allow automatically, or show status",
      argumentHint: "off | ask | auto | status",
      context: "agent",
      async onSubmit({ args, agent, rpc, openPanel }) {
        const command = parseComputerCommand(args);
        if (command.kind === "status") {
          openPanel("computer");
          return;
        }
        await rpc(setModeRpc, { agentId: agent.id, mode: command.mode });
      },
    }),
    client.addCommandCenterItem({
      id: "open-computer",
      title: "Open computer controls",
      icon: "MonitorCog",
      keywords: ["computer", "desktop", "screen", "mouse"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel("computer");
      },
    }),
    client.addCommandCenterItem({
      id: "stop-computer",
      title: "Stop computer use",
      icon: "OctagonX",
      keywords: ["computer", "stop", "emergency"],
      context: "global",
      async onSelect({ rpc }) {
        await rpc(setStopRpc, { stopped: true });
      },
    }),
    client.addCommandCenterItem({
      id: "computer-status",
      title: "Show computer status",
      icon: "MonitorCheck",
      context: "agent",
      async onSelect({ rpc, openPanel }) {
        await rpc(statusRpc, {});
        openPanel("computer");
      },
    }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
