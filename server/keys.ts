// macOS virtual key codes for the US ANSI layout. Names follow the xdotool spelling that
// computer-use models are trained on, compared lower-case with "_" removed ("Page_Down" -> "pagedown").
const KEY_CODES = new Map<string, number>([
  ["a", 0], ["s", 1], ["d", 2], ["f", 3], ["h", 4], ["g", 5], ["z", 6], ["x", 7], ["c", 8], ["v", 9],
  ["b", 11], ["q", 12], ["w", 13], ["e", 14], ["r", 15], ["y", 16], ["t", 17], ["1", 18], ["2", 19],
  ["3", 20], ["4", 21], ["6", 22], ["5", 23], ["=", 24], ["9", 25], ["7", 26], ["-", 27], ["8", 28],
  ["0", 29], ["]", 30], ["o", 31], ["u", 32], ["[", 33], ["i", 34], ["p", 35], ["l", 37], ["j", 38],
  ["'", 39], ["k", 40], [";", 41], ["\\", 42], [",", 43], ["/", 44], ["n", 45], ["m", 46], [".", 47],
  ["`", 50],
  ["return", 36], ["enter", 36], ["tab", 48], ["space", 49], ["backspace", 51], ["delete", 51],
  ["escape", 53], ["esc", 53], ["forwarddelete", 117], ["home", 115], ["end", 119], ["pageup", 116],
  ["pagedown", 121], ["left", 123], ["right", 124], ["down", 125], ["up", 126],
  ["f1", 122], ["f2", 120], ["f3", 99], ["f4", 118], ["f5", 96], ["f6", 97], ["f7", 98], ["f8", 100],
  ["f9", 101], ["f10", 109], ["f11", 103], ["f12", 111],
]);

// CGEventFlags masks.
const COMMAND = 0x100000;
const SHIFT = 0x20000;
const CONTROL = 0x40000;
const OPTION = 0x80000;

const MODIFIER_FLAGS = new Map<string, number>([
  ["cmd", COMMAND], ["command", COMMAND], ["super", COMMAND], ["meta", COMMAND],
  ["shift", SHIFT],
  ["ctrl", CONTROL], ["control", CONTROL],
  ["option", OPTION], ["opt", OPTION], ["alt", OPTION],
]);

export type KeyCombo = { code: number; flags: number };

function normalise(name: string): string {
  return name.trim().toLowerCase().replaceAll("_", "");
}

export function modifierFlags(names: readonly string[]): number {
  let flags = 0;
  for (const name of names) {
    const flag = MODIFIER_FLAGS.get(normalise(name));
    if (flag === undefined) throw new Error(`Unknown modifier "${name}"; expected cmd, shift, option, or ctrl`);
    flags |= flag;
  }
  return flags;
}

// "cmd+shift+t": every part before the last is a modifier, the last is the key.
export function parseKeyCombo(combo: string): KeyCombo {
  const parts = combo.split("+");
  const keyName = parts.pop() ?? "";
  const code = KEY_CODES.get(normalise(keyName));
  if (code === undefined) throw new Error(`Unknown key "${keyName}" in "${combo}"; use names like a, Return, Tab, Escape, Page_Down, F5`);
  return { code, flags: modifierFlags(parts) };
}
