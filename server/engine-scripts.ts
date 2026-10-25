// Fixed JXA programs run with `osascript -l JavaScript -e <script> <json>`. Model text never becomes
// script source: each program reads its one argument with JSON.parse and prints one JSON value.
// Event type, button, and flag numbers are CoreGraphics constants written out, because the JXA
// bridge does not expose every enum. Permission traps are in the plan's part 1 results.

const status = String.raw`
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
function run() {
  var p = $.CGEventGetLocation($.CGEventCreate(null));
  var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var front = app.isNil() ? null : {
    name: ObjC.unwrap(app.localizedName) || '',
    bundleId: ObjC.unwrap(app.bundleIdentifier) || null,
    pid: app.processIdentifier
  };
  var screen = $.NSScreen.mainScreen;
  return JSON.stringify({
    trusted: $.AXIsProcessTrusted(),
    cursor: { x: p.x, y: p.y },
    front: front,
    display: { width: screen.frame.size.width, height: screen.frame.size.height, scale: screen.backingScaleFactor }
  });
}`;

// The window a mouse-down at the point would hit, by macOS's own hit test. The topmost window in
// the window list is not it: Notification Centre keeps an opaque, click-through, full-screen window
// at layer 21. The hit test returns 0 until NSApplication connects to the window server. It takes
// Cocoa coordinates, whose origin is the bottom-left of the main display.
const windowAt = String.raw`
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(argv) {
  var input = JSON.parse(argv[0]);
  $.NSApplication.sharedApplication;
  var mainHeight = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
  var hit = Number($.NSWindow.windowNumberAtPointBelowWindowWithWindowNumber({ x: input.x, y: mainHeight - input.y }, 0));
  if (hit === 0) return JSON.stringify(null);
  var onScreenOnly = 1;
  var windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(onScreenOnly, 0)));
  for (var i = 0; i < windows.length; i++) {
    var w = windows[i];
    if (w.kCGWindowNumber !== hit) continue;
    var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(w.kCGWindowOwnerPID);
    return JSON.stringify({
      pid: w.kCGWindowOwnerPID,
      name: w.kCGWindowOwnerName || '',
      bundleId: app.isNil() ? null : (ObjC.unwrap(app.bundleIdentifier) || null),
      layer: w.kCGWindowLayer
    });
  }
  return JSON.stringify(null);
}`;

// Moves, clicks, drags, or scrolls, then prints where the pointer ended up. Without Accessibility,
// macOS drops posted events silently, so the caller compares this read-back with the target.
const pointer = String.raw`
ObjC.import('CoreGraphics');
var MOVED = 5, DOWN = [1, 3, 25], UP = [2, 4, 26], LEFT_DRAGGED = 6, CLICK_STATE = 1, HID_TAP = 0, LINE_UNITS = 1;
function post(type, x, y, button, flags, clickState) {
  var e = $.CGEventCreateMouseEvent(null, type, { x: x, y: y }, button);
  if (clickState > 0) $.CGEventSetIntegerValueField(e, CLICK_STATE, clickState);
  $.CGEventSetFlags(e, flags);
  $.CGEventPost(HID_TAP, e);
  delay(0.02);
}
function run(argv) {
  var a = JSON.parse(argv[0]);
  if (a.action === 'move') {
    post(MOVED, a.x, a.y, 0, 0, 0);
  } else if (a.action === 'click') {
    post(MOVED, a.x, a.y, 0, a.flags, 0);
    for (var n = 1; n <= a.count; n++) {
      post(DOWN[a.button], a.x, a.y, a.button, a.flags, n);
      post(UP[a.button], a.x, a.y, a.button, a.flags, n);
    }
  } else if (a.action === 'drag') {
    var steps = 20;
    post(MOVED, a.from.x, a.from.y, 0, 0, 0);
    post(DOWN[0], a.from.x, a.from.y, 0, 0, 1);
    for (var s = 1; s <= steps; s++) {
      post(LEFT_DRAGGED, a.from.x + (a.to.x - a.from.x) * s / steps, a.from.y + (a.to.y - a.from.y) * s / steps, 0, 0, 0);
    }
    post(UP[0], a.to.x, a.to.y, 0, 0, 1);
  } else if (a.action === 'scroll') {
    post(MOVED, a.x, a.y, 0, 0, 0);
    for (var t = 0; t < a.ticks; t++) {
      $.CGEventPost(HID_TAP, $.CGEventCreateScrollWheelEvent2(null, LINE_UNITS, 2, a.dy, a.dx, 0));
      delay(0.02);
    }
  } else {
    throw new Error('Unknown pointer action ' + a.action);
  }
  var p = $.CGEventGetLocation($.CGEventCreate(null));
  return JSON.stringify({ x: p.x, y: p.y });
}`;

// Text goes as one UTF-16 unit per key event, which typed emoji and quotes exactly in the spike.
const keyboard = String.raw`
ObjC.import('CoreGraphics');
var HID_TAP = 0;
function postKey(code, down, flags, unit) {
  var e = $.CGEventCreateKeyboardEvent(null, code, down);
  if (unit !== undefined) {
    var buf = Ref('unsigned short');
    buf[0] = unit;
    $.CGEventKeyboardSetUnicodeString(e, 1, buf);
  }
  $.CGEventSetFlags(e, flags);
  $.CGEventPost(HID_TAP, e);
}
function run(argv) {
  var a = JSON.parse(argv[0]);
  if (a.kind === 'text') {
    for (var i = 0; i < a.units.length; i++) {
      postKey(0, true, 0, a.units[i]);
      postKey(0, false, 0, a.units[i]);
      delay(0.01);
    }
  } else if (a.kind === 'key') {
    for (var r = 0; r < a.repeat; r++) {
      postKey(a.code, true, a.flags);
      postKey(a.code, false, a.flags);
      delay(0.03);
    }
  } else {
    throw new Error('Unknown keyboard input ' + a.kind);
  }
  return JSON.stringify({ posted: true });
}`;

const activate = String.raw`
ObjC.import('AppKit');
function run(argv) {
  var input = JSON.parse(argv[0]);
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(input.bundleId);
  if (apps.count === 0) return JSON.stringify({ running: false, activated: false });
  var ignoringOtherApps = 2;
  return JSON.stringify({ running: true, activated: apps.objectAtIndex(0).activateWithOptions(ignoringOtherApps) });
}`;

const resolveApp = String.raw`
ObjC.import('AppKit');
function run(argv) {
  var input = JSON.parse(argv[0]);
  var path = $.NSWorkspace.sharedWorkspace.fullPathForApplication(input.name);
  if (path.isNil()) return JSON.stringify(null);
  var bundle = $.NSBundle.bundleWithPath(path);
  var bundleId = bundle.isNil() ? null : (ObjC.unwrap(bundle.bundleIdentifier) || null);
  return JSON.stringify(bundleId === null ? null : { bundleId: bundleId, path: ObjC.unwrap(path) });
}`;

// Reads the front window's controls through the Accessibility API directly. System Events hung for
// 30 seconds in the spike. Copied values are untyped Refs and go through castRefToObject;
// AXValueGetValue rejects JXA Refs, so frames are parsed from the AXValue description text.
const uiSnapshot = String.raw`
ObjC.import('ApplicationServices');
function run(argv) {
  var input = JSON.parse(argv[0]);
  var deadline = Date.now() + input.budgetMs;
  var app = $.AXUIElementCreateApplication(input.pid);
  function attr(el, name) {
    var ref = Ref();
    if ($.AXUIElementCopyAttributeValue(el, $(name), ref) !== 0) return null;
    return ObjC.castRefToObject(ref[0]);
  }
  function text(el, name) {
    var v = attr(el, name);
    if (v === null) return null;
    var js = ObjC.unwrap(v);
    if (typeof js === 'string') return js.slice(0, 200);
    if (typeof js === 'number' || typeof js === 'boolean') return String(js);
    return null;
  }
  function frame(el) {
    var pos = attr(el, 'AXPosition'), size = attr(el, 'AXSize');
    if (pos === null || size === null) return null;
    var p = /x:(-?[\d.]+) y:(-?[\d.]+)/.exec(ObjC.unwrap(pos.description));
    var s = /w:([\d.]+) h:([\d.]+)/.exec(ObjC.unwrap(size.description));
    if (!p || !s) return null;
    return [Number(p[1]), Number(p[2]), Number(s[1]), Number(s[2])];
  }
  function describe(el) {
    return {
      role: text(el, 'AXRole'),
      label: text(el, 'AXTitle') || text(el, 'AXDescription'),
      value: text(el, 'AXSubrole') === 'AXSecureTextField' ? null : text(el, 'AXValue'),
      frame: frame(el)
    };
  }
  function children(el) {
    var kids = attr(el, 'AXChildren'), out = [];
    if (kids !== null) for (var i = 0; i < kids.count; i++) out.push(kids.objectAtIndex(i));
    return out;
  }
  var elements = [], cut = false;
  var root = attr(app, 'AXFocusedWindow');
  if (root === null) {
    var windows = attr(app, 'AXWindows');
    if (windows !== null && windows.count > 0) root = windows.objectAtIndex(0);
  }
  var queue = root === null ? [] : [root];
  while (queue.length > 0) {
    if (elements.length >= input.max || Date.now() > deadline) { cut = true; break; }
    var el = queue.shift();
    elements.push(describe(el));
    queue = queue.concat(children(el));
  }
  var menuBar = attr(app, 'AXMenuBar');
  var menus = menuBar === null ? [] : children(menuBar);
  for (var m = 0; m < menus.length; m++) {
    if (elements.length >= input.max || Date.now() > deadline) { cut = true; break; }
    elements.push(describe(menus[m]));
  }
  return JSON.stringify({ elements: elements, cut: cut });
}`;

export const SCRIPTS = { status, windowAt, pointer, keyboard, activate, resolveApp, uiSnapshot } as const;
export type ScriptName = keyof typeof SCRIPTS;
