import { describe, expect, it } from "vitest";
import { nextMode, parseComputerCommand } from "./commands";

describe("computer controls", () => {
  it("parses each supported computer command and rejects anything else", () => {
    expect(parseComputerCommand("ask")).toEqual({ kind: "mode", mode: "ask" });
    expect(parseComputerCommand(" AUTO ")).toEqual({ kind: "mode", mode: "auto" });
    expect(parseComputerCommand("off")).toEqual({ kind: "mode", mode: "off" });
    expect(parseComputerCommand("status")).toEqual({ kind: "status" });
    expect(() => parseComputerCommand("")).toThrow("Expected /computer off, ask, auto, or status");
    expect(() => parseComputerCommand("on")).toThrow('Unknown computer mode "on"');
  });

  it("cycles off to ask to auto without skipping the approval mode", () => {
    expect(nextMode("off")).toBe("ask");
    expect(nextMode("ask")).toBe("auto");
    expect(nextMode("auto")).toBe("off");
  });
});
