import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const modeSchema = z.enum(["off", "ask", "auto"]);
export type Mode = z.infer<typeof modeSchema>;

export const bundleIdSchema = z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/, "Expected a bundle id like com.apple.TextEdit");

export const settingsSchema = z.object({
  approvalTimeoutSeconds: z.number().int().min(5).max(55).default(45),
  extraNoInput: z.array(bundleIdSchema).max(100).default([]),
  extraNoView: z.array(bundleIdSchema).max(100).default([]),
  disabledBuiltIns: z.array(bundleIdSchema).max(100).default([]),
  // Fixed, because agents keep the tool server address they were created with. 6790 and 6791 are
  // memorise's on this Mac.
  mcpPort: z.number().int().min(1024).max(65535).default(6797),
});
export type Settings = z.infer<typeof settingsSchema>;

export const computerSettings = defineSettings({ id: "computer", scope: "host", version: 1, schema: settingsSchema });

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

export const lastScreenshotSchema = z.object({ agentId: z.string(), jpegBase64: z.string(), width: z.number().positive(), height: z.number().positive(), time: z.string() });
export type LastScreenshot = z.infer<typeof lastScreenshotSchema>;

export const answerApprovalRpc = defineRpc({
  name: "computer.approval.answer",
  input: z.object({ requestId: z.string().min(1), agentId: z.string().min(1), allow: z.boolean() }),
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
    screenshot: lastScreenshotSchema.nullable(),
    recent: z.array(activitySchema).max(25),
  }),
});
