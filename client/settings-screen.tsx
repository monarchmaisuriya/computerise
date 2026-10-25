import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { computerSettings, type Settings } from "../shared/contracts";
import { parseBundleIds, parseTimeout } from "./settings-draft";

export function ComputerSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(computerSettings);
  const [timeout, setTimeoutDraft] = useState<string>();
  const [port, setPort] = useState<string>();
  const [noInput, setNoInput] = useState<string>();
  const [noView, setNoView] = useState<string>();
  const [inputError, setInputError] = useState<string | null>(null);
  if (settings.status !== "ready") return <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>{settings.status === "loading" ? "Loading settings" : settings.error}</Text>;
  const save = (values: Settings) => void settings.save(values, settings.revision);
  const saveDrafts = () => {
    try {
      const next = {
        ...settings.values,
        approvalTimeoutSeconds: timeout === undefined ? settings.values.approvalTimeoutSeconds : parseTimeout(timeout),
        mcpPort: port === undefined ? settings.values.mcpPort : Number(port.trim()),
        extraNoInput: noInput === undefined ? settings.values.extraNoInput : parseBundleIds(noInput),
        extraNoView: noView === undefined ? settings.values.extraNoView : parseBundleIds(noView),
      };
      const parsed = computerSettings.schema.safeParse(next);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Settings are not valid");
      setInputError(null);
      void settings.save(parsed.data, settings.revision).then((saved) => {
        if (saved) {
          setTimeoutDraft(undefined);
          setPort(undefined);
          setNoInput(undefined);
          setNoView(undefined);
        }
      });
    } catch (error) {
      setInputError(error instanceof Error ? error.message : String(error));
    }
  };
  const hasDraft = timeout !== undefined || port !== undefined || noInput !== undefined || noView !== undefined;
  return (
    <>
      <SettingsSection title="Approvals">
        <SettingsCard>
          <SettingsInput label="Wait for an answer (seconds)" hint="From 5 to 55. Default 45. An unanswered action does nothing." initialValue={String(settings.values.approvalTimeoutSeconds)} disabled={settings.saving} onChangeText={setTimeoutDraft} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Privacy">
        <SettingsCard>
          <SettingsSwitch
            label="Show agents only the front app"
            hint="Screenshots and zooms show only the windows of the app in front; the rest of the screen is black. Off shows the whole main display."
            value={settings.values.screenshotScope === "front-app"}
            disabled={settings.saving}
            onValueChange={(on) => save({ ...settings.values, screenshotScope: on ? "front-app" : "display" })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Blocked apps" info="Paseo, terminals, code-running apps, System Settings, and password managers are always blocked. Password managers are hidden from screenshots as well as input.">
        <SettingsCard>
          <SettingsInput label="Extra apps with input blocked" hint="Bundle IDs separated by commas or new lines." initialValue={settings.values.extraNoInput.join("\n")} disabled={settings.saving} onChangeText={setNoInput} />
          <SettingsInput label="Extra apps hidden and blocked" hint="Bundle IDs separated by commas or new lines." initialValue={settings.values.extraNoView.join("\n")} disabled={settings.saving} onChangeText={setNoView} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Advanced">
        <SettingsCard>
          <SettingsInput label="Computer tools port" hint="Default 6797. Applies after plugin reload; existing agents keep their old address." initialValue={String(settings.values.mcpPort)} disabled={settings.saving} onChangeText={setPort} />
          <SettingsAction label="" actionLabel="Save settings" disabled={settings.saving || !hasDraft} error={inputError ?? settings.saveError} onPress={saveDrafts} />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
