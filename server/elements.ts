import type { Point, UiSnapshot } from "./engine";
import type { AppRef } from "./policy";

// Element numbers from ui_snapshot, kept per agent so an action can name a control instead of a
// point. A number is only a position in the list; an action re-reads the window and acts only if
// that position still holds the same control.

type Element = UiSnapshot["elements"][number];
type Frame = NonNullable<Element["frame"]>;

export type ElementTable = { pid: number; app: AppRef; max: number; elements: Element[] };

// Taken when an action is planned and carried to execution, so the control the user approves is
// the control compared before acting, even if a later call replaces the agent's table meanwhile.
export type ExpectedElement = { number: number; pid: number; app: AppRef; max: number; element: Element & { frame: Frame } };

export class ElementTables {
  private readonly tables = new Map<string, ElementTable>();

  get(agentId: string): ElementTable | undefined {
    return this.tables.get(agentId);
  }

  set(agentId: string, table: ElementTable): void {
    this.tables.set(agentId, table);
  }

  clear(agentId: string): void {
    this.tables.delete(agentId);
  }

  clearAll(): void {
    this.tables.clear();
  }
}

export function describeElement(element: Element): string {
  return `${element.role ?? "unknown"}${element.label ? ` ${JSON.stringify(element.label)}` : ""}`;
}

// Roles whose value is what the user types. Typing into one must not make it a different control.
const EDITABLE_ROLES = new Set(["AXTextField", "AXTextArea", "AXComboBox"]);

// Unlabelled rows, cells, and text are told apart only by their value, so a row whose message was
// replaced at the same position is a different control.
function sameControl(a: Element, b: Element): boolean {
  const position = (frame: Element["frame"]) => frame?.map(Math.round) ?? null;
  const sameValue = (a.role !== null && EDITABLE_ROLES.has(a.role)) || a.value === b.value;
  return a.role === b.role && a.label === b.label && sameValue && JSON.stringify(position(a.frame)) === JSON.stringify(position(b.frame));
}

export function pickElement(table: ElementTable | undefined, number: number): { expected: ExpectedElement } | { refusal: string } {
  if (!table) return { refusal: "No element numbers yet: call ui_snapshot first" };
  const element = table.elements[number - 1];
  if (!element) return { refusal: `Element ${number} is not in your last ui_snapshot, which listed ${table.elements.length} elements` };
  const { frame } = element;
  if (!frame) return { refusal: `Element ${number} (${describeElement(element)}) has no position on screen` };
  return { expected: { number, pid: table.pid, app: table.app, max: table.max, element: { ...element, frame } } };
}

export function matchLive(expected: ExpectedElement, live: UiSnapshot): { element: Element & { frame: Frame } } | { refusal: string } {
  const now = live.elements[expected.number - 1];
  if (now?.frame && sameControl(expected.element, now)) return { element: { ...now, frame: now.frame } };
  const at = now?.frame ? ` at ${Math.round(now.frame[0])},${Math.round(now.frame[1])}` : "";
  const found = now ? `${describeElement(now)}${at}` : "missing";
  return { refusal: `Element ${expected.number} changed since your last ui_snapshot (was ${describeElement(expected.element)}, now ${found}); call ui_snapshot again` };
}

const SHOWN_CHANGES = 30;
const SHOWN_VALUE_CHARS = 80;

function shownValue(value: string | null): string {
  if (value === null) return "none";
  return JSON.stringify(value.length > SHOWN_VALUE_CHARS ? `${value.slice(0, SHOWN_VALUE_CHARS)}...` : value);
}

// What an action changed in the front window, from a read just before it and one just after. A
// control is the same control when role, label, and position match (sameControl), so a value
// change shows as "~"; moved controls show as removed and added. before is null when nothing could
// be read before the action (no front app, or a front app blocked from view).
export function describeChange(before: { pid: number; elements: Element[] } | null, after: { pid: number; app: AppRef; elements: Element[]; cut: boolean }): string {
  if (before === null || before.pid !== after.pid) return `Front app is now ${after.app.name} (${after.elements.length} controls); element numbers now refer to its front window.`;
  const unmatched = [...before.elements];
  const lines: string[] = [];
  after.elements.forEach((element, i) => {
    const index = unmatched.findIndex((old) => sameControl(old, element));
    if (index === -1) {
      lines.push(`+ ${i + 1}. ${describeElement(element)}`);
      return;
    }
    const [old] = unmatched.splice(index, 1);
    if (old.value !== element.value) lines.push(`~ ${i + 1}. ${describeElement(element)} value ${shownValue(element.value)} (was ${shownValue(old.value)})`);
  });
  for (const old of unmatched) lines.push(`- ${describeElement(old)}`);
  const cut = after.cut ? [`The list was cut short at ${after.elements.length} controls; changes further down are not shown.`] : [];
  if (lines.length === 0) return [`No change detected in ${after.app.name}'s controls. The action may have done nothing, or changed something the accessibility tree does not show; take a screenshot to check.`, ...cut].join("\n");
  const more = lines.length > SHOWN_CHANGES ? [`... and ${lines.length - SHOWN_CHANGES} more; call ui_snapshot for the full list`] : [];
  return [`Changed in ${after.app.name} (${lines.length} changes; ${after.elements.length} controls now):`, ...lines.slice(0, SHOWN_CHANGES), ...more, ...cut].join("\n");
}

export function center(frame: Frame): Point {
  return { x: Math.round(frame[0] + frame[2] / 2), y: Math.round(frame[1] + frame[3] / 2) };
}
