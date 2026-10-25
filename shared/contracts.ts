import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const modeSchema = z.enum(["off", "ask", "auto"]);
export type Mode = z.infer<typeof modeSchema>;

export const bundleIdSchema = z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/, "Expected a bundle id like com.apple.TextEdit");

export const settingsSchema = z.object({
  approvalTimeoutSeconds: z.number().int().min(5).max(55).default(45),
  extraNoInput: z.array(bundleIdSchema).max(100).default([]),
  extraNoView: z.array(bundleIdSchema).max(100).default([]),
  // "front-app" shows the model only the front app's windows; the rest of the display is black.
  screenshotScope: z.enum(["display", "front-app"]).default("display"),
  // Fixed, because agents keep the tool server address they were created with. 6790 and 6791 are
  // memorise's on this Mac.
  mcpPort: z.number().int().min(1024).max(65535).default(6797),
});
export type Settings = z.infer<typeof settingsSchema>;

export const computerSettings = defineSettings({
  id: "computer",
  scope: "host",
  version: 2,
  schema: settingsSchema,
  migrate(values, fromVersion) {
    if (fromVersion !== 1) throw new Error(`Cannot migrate computer settings from version ${fromVersion}`);
    return settingsSchema.parse(values);
  },
});

export const setModeRpc = defineRpc({
  name: "computer.mode.set",
  input: z.object({ agentId: z.string().min(1), mode: modeSchema }),
  output: z.object({ mode: modeSchema }),
});

export const statusRpc = defineRpc({
  name: "computer.status",
  input: z.object({}),
  output: z.object({ stopped: z.boolean(), modes: z.record(z.string(), modeSchema), holder: z.string().nullable() }),
});

export const activitySchema = z.object({
  time: z.string(),
  agentId: z.string().nullable(),
  tool: z.string(),
  target: z.string().nullable(),
  outcome: z.string(),
  chars: z.number().int().nonnegative().optional(),
});
export type Activity = z.infer<typeof activitySchema>;

// The panel polls this small description and fetches the image only when the id changes.
export const screenshotInfoSchema = z.object({ id: z.string(), agentId: z.string(), width: z.number().positive(), height: z.number().positive(), time: z.string() });
export type ScreenshotInfo = z.infer<typeof screenshotInfoSchema>;

export const panelScreenshotRpc = defineRpc({
  name: "computer.panel.screenshot",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ id: z.string(), jpegBase64: z.string() }),
});

// Screen Recording is known only from the last capture: JXA cannot ask macOS directly.
export const screenRecordingSchema = z.enum(["granted", "missing", "unknown"]);
export type ScreenRecording = z.infer<typeof screenRecordingSchema>;

export const healthSchema = z.object({
  accessibility: z.enum(["granted", "missing"]).nullable(),
  screenRecording: screenRecordingSchema,
  engineError: z.string().nullable(),
});

// Fixed actions, so the panel can never make the plugin open an arbitrary address.
export const permissionActionSchema = z.enum(["open-accessibility-settings", "open-screen-recording-settings", "ask-macos-for-accessibility", "check-screen-recording"]);
export type PermissionAction = z.infer<typeof permissionActionSchema>;

// Answers with fresh health, so the panel shows the result of the action at once.
export const permissionActionRpc = defineRpc({
  name: "computer.permission.act",
  input: z.object({ action: permissionActionSchema }),
  output: healthSchema,
});

// "app-for-turn" also allows later pointer actions in the same app until the agent's turn ends.
export const approvalScopeSchema = z.enum(["once", "app-for-turn"]);
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

export const answerApprovalRpc = defineRpc({
  name: "computer.approval.answer",
  input: z.object({ requestId: z.string().min(1), agentId: z.string().min(1), allow: z.boolean(), scope: approvalScopeSchema.default("once") }),
  output: z.object({ answered: z.literal(true) }),
});

export const setStopRpc = defineRpc({
  name: "computer.stop.set",
  input: z.object({ stopped: z.boolean() }),
  output: z.object({ stopped: z.boolean() }),
});

export const APPROVAL_ROW_KIND = "computerise-approval";

export const approvalStatusSchema = z.enum(["pending", "allowed", "denied", "timed out", "cancelled"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalRowSchema = z.object({
  requestId: z.string(),
  action: z.string(),
  app: z.string(),
  status: approvalStatusSchema,
  // The app the user may allow for the rest of the turn; null when this action always asks.
  // Rows written before this field existed read as null.
  appScope: z.string().nullable().default(null),
});
export type ApprovalRow = z.infer<typeof approvalRowSchema>;

export const panelStatusRpc = defineRpc({
  name: "computer.panel.status",
  input: z.object({}),
  output: z.object({
    stopped: z.boolean(),
    modes: z.record(z.string(), modeSchema),
    holder: z.string().nullable(),
    pending: z.array(approvalRowSchema.extend({ agentId: z.string() })),
    screenshot: screenshotInfoSchema.nullable(),
    recent: z.array(activitySchema).max(25),
  }),
});

// Separate from panel status, so Stop, modes, and approvals never wait behind a long engine call.
export const panelHealthRpc = defineRpc({
  name: "computer.panel.health",
  input: z.object({}),
  output: healthSchema,
});
