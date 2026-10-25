import { describe, expect, it } from "vitest";
import { center, describeChange, type ElementTable, ElementTables, matchLive, pickElement } from "./elements";
import type { UiSnapshot } from "./engine";

type Element = UiSnapshot["elements"][number];

const TEXTEDIT = { bundleId: "com.apple.TextEdit", name: "TextEdit" };
const SAVE = { role: "AXButton", label: "Save", value: null, frame: [100, 200, 80, 30] as [number, number, number, number] };
const FIELD = { role: "AXTextField", label: "Name", value: "ab", frame: [10, 20, 300, 24] as [number, number, number, number] };
const NO_FRAME: Element = { ...SAVE, frame: null };

function table(elements: Element[] = [FIELD, SAVE]): ElementTable {
  return { pid: 42, app: TEXTEDIT, max: 200, elements };
}

describe("picking an element by number", () => {
  it("refuses before any ui_snapshot", () => {
    expect(pickElement(undefined, 1)).toEqual({ refusal: "No element numbers yet: call ui_snapshot first" });
  });

  it("refuses a number the last ui_snapshot did not list", () => {
    expect(pickElement(table(), 3)).toEqual({ refusal: "Element 3 is not in your last ui_snapshot, which listed 2 elements" });
  });

  it("refuses an element without a position", () => {
    expect(pickElement(table([NO_FRAME]), 1)).toEqual({ refusal: 'Element 1 (AXButton "Save") has no position on screen' });
  });

  it("keeps what was picked when the table changes later", () => {
    const source = table();
    const picked = pickElement(source, 2);
    source.elements[1] = { ...SAVE, label: "Delete" };
    expect(picked).toEqual({ expected: { number: 2, pid: 42, app: TEXTEDIT, max: 200, element: SAVE } });
  });
});

describe("matching the picked element against a fresh read", () => {
  const expected = { number: 2, pid: 42, app: TEXTEDIT, max: 200, element: SAVE };

  it("accepts the same control even when its value changed", () => {
    const live = { elements: [{ ...FIELD, value: "abc" }, { ...SAVE, value: "x" }], cut: false };
    expect(matchLive(expected, live)).toEqual({ element: { ...SAVE, value: "x" } });
  });

  it("treats sub-point frame differences as the same position", () => {
    const live = { elements: [FIELD, { ...SAVE, frame: [100.2, 199.8, 80, 30] as [number, number, number, number] }], cut: false };
    expect(matchLive(expected, live)).toHaveProperty("element");
  });

  it.each([
    ["moved", { ...SAVE, frame: [140, 200, 80, 30] as [number, number, number, number] }, 'was AXButton "Save", now AXButton "Save" at 140,200'],
    ["relabelled", { ...SAVE, label: "Delete" }, 'was AXButton "Save", now AXButton "Delete"'],
  ])("refuses a control that %s", (_case, now, detail) => {
    const result = matchLive(expected, { elements: [FIELD, now], cut: false });
    expect(result).toEqual({ refusal: expect.stringContaining(`Element 2 changed since your last ui_snapshot (${detail}`) });
    expect(result).toEqual({ refusal: expect.stringContaining("call ui_snapshot again") });
  });

  it("refuses when the fresh read no longer reaches that number", () => {
    expect(matchLive(expected, { elements: [FIELD], cut: true })).toEqual({ refusal: 'Element 2 changed since your last ui_snapshot (was AXButton "Save", now missing); call ui_snapshot again' });
  });
});

describe("the point an element action uses", () => {
  it("is the middle of the frame in whole points", () => {
    expect(center([100, 200, 81, 31])).toEqual({ x: 141, y: 216 });
  });
});

describe("element tables", () => {
  it("keeps one table per agent and clears per agent or all", () => {
    const tables = new ElementTables();
    tables.set("a", table());
    tables.set("b", table([SAVE]));
    expect(tables.get("a")?.elements).toHaveLength(2);
    tables.clear("a");
    expect(tables.get("a")).toBeUndefined();
    expect(tables.get("b")?.elements).toHaveLength(1);
    tables.clearAll();
    expect(tables.get("b")).toBeUndefined();
  });
});

describe("describing what an action changed", () => {
  const before = { pid: 42, elements: [FIELD, SAVE] };
  const after = (elements: Element[], pid = 42, name = "TextEdit") => ({ pid, app: { bundleId: null, name }, elements, cut: false });

  it("says nothing changed when the controls are the same", () => {
    expect(describeChange(before, after([FIELD, SAVE]))).toBe(
      "No change detected in TextEdit's controls. The action may have done nothing, or changed something the accessibility tree does not show; take a screenshot to check.",
    );
  });

  it("lists changed values and added controls by their new numbers, then removed ones", () => {
    const done = { role: "AXButton", label: "Done", value: null, frame: [200, 200, 80, 30] as [number, number, number, number] };
    expect(describeChange(before, after([{ ...FIELD, value: "abc" }, done]))).toBe(
      ['Changed in TextEdit (3 changes; 2 controls now):', '~ 1. AXTextField "Name" value "abc" (was "ab")', '+ 2. AXButton "Done"', '- AXButton "Save"'].join("\n"),
    );
  });

  it("names the new front app when the action brought another app forward, or nothing could be read before", () => {
    const text = "Front app is now Notes (1 controls); element numbers now refer to its front window.";
    expect(describeChange(before, after([SAVE], 43, "Notes"))).toBe(text);
    expect(describeChange(null, after([SAVE], 43, "Notes"))).toBe(text);
  });

  it("shows at most 30 changes", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...SAVE, label: `Item ${i}` }));
    const lines = describeChange({ pid: 42, elements: [] }, after(many)).split("\n");
    expect(lines).toHaveLength(32);
    expect(lines[31]).toBe("... and 10 more; call ui_snapshot for the full list");
  });

  it("shortens long values", () => {
    const long = "x".repeat(200);
    expect(describeChange(before, after([{ ...FIELD, value: long }, SAVE]))).toContain(`value "${"x".repeat(80)}..." (was "ab")`);
  });

  it("says when a list was cut short, since changes past the cut are not compared", () => {
    expect(describeChange(before, { ...after([FIELD, SAVE]), cut: true })).toContain("The list was cut short at 2 controls; changes further down are not shown.");
  });
});
