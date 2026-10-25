import { describe, expect, it } from "vitest";
import { PanelState } from "./panel-state";

describe("computer panel state", () => {
  it("keeps the latest screenshot and newest twenty-five actions without typed text", () => {
    let now = 0;
    const state = new PanelState(() => new Date(++now).toISOString());
    state.screenshot("agent-x", Buffer.from("jpeg"), 1512, 982);
    for (let i = 0; i < 30; i += 1) state.activity({ agentId: "agent-x", tool: "type", target: "com.apple.TextEdit", outcome: "ok", chars: i });

    const shot = state.snapshot().screenshot;
    expect(shot).toEqual({ id: expect.any(String), agentId: "agent-x", width: 1512, height: 982, time: new Date(1).toISOString() });
    expect(JSON.stringify(state.snapshot())).not.toContain("anBlZw==");
    expect(state.image(shot?.id as string)).toEqual({ id: shot?.id, jpegBase64: "anBlZw==" });
    expect(state.snapshot().recent).toHaveLength(25);
    expect(state.snapshot().recent[0]).toMatchObject({ tool: "type", chars: 29 });
    expect(JSON.stringify(state.snapshot())).not.toContain("hello");
  });

  it("gives each screenshot a new id and refuses an id it no longer keeps", () => {
    const state = new PanelState();
    state.screenshot("agent-x", Buffer.from("first"), 10, 10);
    const first = state.snapshot().screenshot?.id as string;
    state.screenshot("agent-x", Buffer.from("second"), 10, 10);
    const second = state.snapshot().screenshot?.id as string;
    expect(second).not.toBe(first);
    expect(() => state.image(first)).toThrow(`Screenshot ${first} was replaced by a newer one`);
    expect(state.image(second).jpegBase64).toBe(Buffer.from("second").toString("base64"));
  });
});
