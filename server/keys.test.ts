import { describe, expect, it } from "vitest";
import { modifierFlags, parseKeyCombo } from "./keys";

describe("reading a key combination", () => {
  it("turns xdotool-style names into a macOS key code and modifier flags", () => {
    expect(parseKeyCombo("cmd+shift+t")).toEqual({ code: 17, flags: 0x100000 | 0x20000 });
    expect(parseKeyCombo("Return")).toEqual({ code: 36, flags: 0 });
    expect(parseKeyCombo("ctrl+Page_Down")).toEqual({ code: 121, flags: 0x40000 });
    expect(parseKeyCombo("alt+BackSpace")).toEqual({ code: 51, flags: 0x80000 });
  });

  it("refuses unknown keys and modifiers, naming them", () => {
    expect(() => parseKeyCombo("hyper+x")).toThrow('Unknown modifier "hyper"');
    expect(() => parseKeyCombo("cmd+launch")).toThrow('Unknown key "launch" in "cmd+launch"');
    expect(() => parseKeyCombo("cmd+")).toThrow('Unknown key "" in "cmd+"');
    expect(() => parseKeyCombo("")).toThrow('Unknown key ""');
    expect(() => parseKeyCombo("a+b")).toThrow('Unknown modifier "a"');
  });

  it("does not treat built-in object property names as keys", () => {
    expect(() => parseKeyCombo("constructor")).toThrow('Unknown key "constructor"');
    expect(() => modifierFlags(["toString"])).toThrow('Unknown modifier "toString"');
  });
});
