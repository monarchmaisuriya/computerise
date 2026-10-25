import { describe, expect, it } from "vitest";
import { PanelState } from "./panel-state";

describe("computer panel state", () => {
  it("keeps the latest screenshot and newest twenty-five actions without typed text", () => {
    let now = 0;
    const state = new PanelState(() => new Date(++now).toISOString());
    state.screenshot("agent-x", Buffer.from("jpeg"), 1512, 982);
    for (let i = 0; i < 30; i += 1) state.activity({ agentId: "agent-x", tool: "type", target: "com.apple.TextEdit", outcome: "ok", chars: i });

    expect(state.snapshot().screenshot).toEqual({ agentId: "agent-x", jpegBase64: "anBlZw==", width: 1512, height: 982, time: new Date(1).toISOString() });
    expect(state.snapshot().recent).toHaveLength(25);
    expect(state.snapshot().recent[0]).toMatchObject({ tool: "type", chars: 29 });
    expect(JSON.stringify(state.snapshot())).not.toContain("hello");
  });
});
