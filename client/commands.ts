import type { Mode } from "../shared/contracts";

export type ComputerCommand = { kind: "status" } | { kind: "mode"; mode: Mode };

export function parseComputerCommand(raw: string): ComputerCommand {
  const value = raw.trim().toLowerCase();
  if (value === "status") return { kind: "status" };
  if (value === "off" || value === "ask" || value === "auto") return { kind: "mode", mode: value };
  if (value === "") throw new Error("Expected /computer off, ask, auto, or status");
  throw new Error(`Unknown computer mode ${JSON.stringify(value)}. Expected off, ask, auto, or status`);
}

export function nextMode(mode: Mode): Mode {
  return mode === "off" ? "ask" : mode === "ask" ? "auto" : "off";
}
