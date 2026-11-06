# Black out hidden apps' windows in full-display captures

- Date: 2026-11-03 10:54
- Status: done (part 3 of 3)
- Repos: computerise   Folders: server/, client/, docs at the root
- Files: server/engine-scripts.ts, server/engine.ts, server/mcp.ts, server/test-engine.ts, server/engine.test.ts, server/mcp.test.ts, server/engine.live.test.ts, OVERVIEW.md, README.md
- Subagents: none

## Context and problem

The settings screen tells the user "Password managers are hidden from screenshots as well as input" (client/settings-screen.tsx:60), and the field for extra apps says "Extra apps hidden and blocked" (client/settings-screen.tsx:63). With the default full-display setting this is only true while that app is in front. A 1Password window open beside the browser is captured and sent to the agent's model provider. Agents in the default ask mode take screenshots without asking, so this needs no approval.

M chose (2026-11-03): black out those windows in the image, so screenshots keep working.

## Goals / Non-goals

Goals:

- In the full-display scope, every on-screen window of an app blocked from view ("no-view": built-in password managers plus the user's extra hidden apps) is black in the screenshot and zoom images the agent and the Computer panel receive.
- If the plugin cannot tell which windows to black out, the capture is refused. It never falls back to an unmasked image.
- The agent is told when windows were blacked out, so it does not try to read them.

Non-goals:

- Hiding content a password manager draws inside another app (for example a browser extension's autofill overlay).
- The accessibility snapshot (ui_snapshot). It reads only the front app, which is already refused when it is blocked from view.
- The front-app scope. It already captures only the front app's own windows.
- Masking only the visible part of a covered window. The whole window rectangle is blacked out, even where another window covers it.
- A version bump or release (see Open questions).

## What is true today

```
screenshot / zoom tool
  -> read(): refuse if FRONT app is no-view          [verified: server/mcp.ts:274]
  -> screenshotSpec.run / zoom run
       capturedPid(): null in display scope          [verified: server/mcp.ts:76-80]
       engine.screenshot(null) / engine.zoom(r, null)
         -> screencapture -m  (or -R region)         [verified: server/engine.ts:281, :292]
         -> sips resample to point width (screenshot only) [verified: server/engine.ts:344]
            <-- nothing removes other apps' windows here
  -> read(): refuse if front app changed or is no-view  [verified: server/mcp.ts:276-278]
```

- `blockLevel` decides "no-view" from the built-in list and `settings.extraNoView` [verified: server/policy.ts:14-22]. It is called only in server/mcp.ts [verified: refuter grep].
- The front-app scope already lists one process's windows (`windowsOf`) and draws them onto a black canvas with the `compose` JXA script, never falling back to a full capture [verified: server/engine.ts:296-325, server/engine-scripts.ts:243-282].
- `compose` takes a region, a scale, an output path, and image layers, and writes a JPEG at quality 0.7 [verified: server/engine-scripts.ts:261-282].
- Window bounds and owners are readable without Screen Recording; `windowAt` already reads them for every window [verified: server/engine-scripts.ts:33-56].
- No test covers a no-view window that is visible but not in front [verified: refuter report; mcp.test.ts no-view tests all put 1Password in front].

## Options considered

| Option | How it works | Tradeoffs | Fails when | Completeness |
| --- | --- | --- | --- | --- |
| Refuse the capture | Refuse while any no-view app has a window on screen | Least code; screenshots stop until the window closes | User keeps a password manager open all day | 8/10 |
| Black out its windows (chosen) | Capture, then paint black over each no-view window's rectangle | Screenshots keep working; one more script step | A hidden window opens and closes between the two window lists (milliseconds) | 9/10 |
| Fix the text only | Say "only when in front" | No code; leak stays | Always | 4/10 |
| ScreenCaptureKit exclusion | Ask macOS to leave the apps out of the capture | Exact, no race | JXA cannot drive its async API reliably | not feasible here |

RECOMMENDATION: Black out its windows, because M chose it and it reuses the tested compose path.

## Decision

Black out the windows of no-view apps in full-display screenshots and zooms. The decision about which apps are hidden stays in the policy layer (`blockLevel`, called from server/mcp.ts); the engine only lists windows and paints rectangles it is given. This keeps one owner for "what is hidden" and keeps settings out of the engine.

## Design

```
screenshot / zoom tool (display scope)
  -> read(): refuse if front app is no-view          (unchanged)
  -> hiddenRects():  engine.onScreenWindows()        <-- new script, all on-screen windows with bundle ids
                     keep windows whose app blockLevel(...) === "no-view"
  -> engine.screenshot(null, hide) / engine.zoom(r, null, hide)
       hide empty:   today's path, unchanged
       hide given:   screencapture raw (full pixels)
                     compose({ region, scale, out, layers: [raw over the whole region], hide })
                                                     <-- compose fills each hide rect black after the layers
  -> hiddenRects() again; refuse if the set changed   <-- new: a hidden window moved or appeared mid-capture
  -> read(): front-app checks (unchanged)
```

- **New script `onScreenWindows`** (server/engine-scripts.ts): every on-screen window (`onScreenOnly | excludeDesktop`, as `windowsOf` uses), with `id`, `bundleId` (null when unknown), and bounds in points.
- **New engine method `onScreenWindows()`** (server/engine.ts), validated with zod like the other scripts.
- **`screenshot(onlyPid, hide = [])` and `zoom(region, onlyPid, hide = [])`**: `hide` is a list of rectangles in points. Empty means nothing is painted and today's commands run unchanged. Non-empty with `onlyPid === null` means: capture at full pixels, then `compose` with the raw image as the only layer and the rectangles painted black. The full-display screenshot is composed at scale 1, so no `sips` step is needed (as the front-app path does today).
- **`compose` gains `hide`**: an array of `{ x, y, width, height }` filled black after the layers. Existing callers pass an empty array. Rectangles outside the region fall off the canvas.
- **server/mcp.ts**: a helper used by both `screenshotSpec` and `zoom`. In display scope it lists hidden windows before and after the capture and refuses with "A hidden app's window moved or appeared while capturing; try again" if the two lists differ by id or bounds. In front-app scope it passes no rectangles and lists nothing. When rectangles were painted, the text result adds "; windows of apps hidden from view are blacked out".
- **Fail closed**: if listing windows or composing fails, the tool fails. There is no path from a failure to an unmasked image.
- **Windows with no bundle id** are not hidden (`blockLevel(null)` is "no-input", not "no-view"). They cannot match the list, so this is unchanged behavior.
- **No new settings.** The list of hidden apps is the existing built-in list plus `extraNoView`. An empty `extraNoView` hides only the built-in password managers.
- **Docs**: OVERVIEW.md "Safety and data" and README.md "Security model" say windows of password managers and hidden apps are blacked out of full-display screenshots, including whatever overlaps them. The settings text becomes accurate as written.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | How noticed |
| --- | --- | --- | --- | --- |
| A hidden window opens and closes entirely between the two window lists | Very low (milliseconds) | One unmasked frame | Before-and-after comparison catches any window that stays; documented as a limit | Not observable; stated in OVERVIEW |
| Black rectangle covers parts of other windows above a hidden window | Medium | Agent sees less of the screen | Accepted over-masking; text tells the agent windows were blacked out | Agent output, panel image |
| Composed image misaligned with points (wrong scale or origin) | Low | Mask misses part of a window | Same coordinate math as the tested front-app compose; live test checks a pixel inside the masked window | Live test |
| The extra script calls slow every screenshot | Low | A few ms per call through the script host | Masking path runs only when a hidden window is on screen; listing is one CGWindowList call | Timing in live test |
| A password manager's menu-bar icon is blacked out | High when 1Password runs | Small black square in the menu bar | Accepted; safe direction | Panel image |
| `compose` contract change breaks the front-app path | Low | Front-app screenshots fail | Existing front-app tests updated to pass an empty `hide`; live test reruns | Unit and live tests |

## Acceptance criteria

- Given display scope and a 1Password window on screen behind TextEdit, when the agent takes a screenshot, then the engine is called with that window's rectangle to hide, the text says windows were blacked out, and the panel gets the same masked image.
- Given an app in `extraNoView` with a window on screen, when the agent zooms into a region, then that window's rectangle is passed to the zoom.
- Given no hidden window on screen, when the agent takes a screenshot, then the engine runs today's commands (`screencapture -m`, then `sips`) with no compose.
- Given front-app scope, when the agent takes a screenshot, then no window list is read and no rectangle is passed.
- Given a hidden window appears between the two lists, when the agent takes a screenshot, then it is refused and no image reaches the agent or the panel.
- Given listing windows fails, when the agent takes a screenshot in display scope, then it fails and no image is returned.
- Given rectangles to hide, when the engine captures the display, then it composes the raw capture at scale 1 with those rectangles, skips `sips`, and deletes every temporary file.
- Given a live Mac with a TextEdit window passed as hidden, when the engine takes a screenshot, then the pixel at that window's middle is black (opt-in `npm run test:live`).

## Rollout and rollback

- No flag. The behavior change is confined to full-display captures while a hidden app has a window on screen.
- Rollback: revert the commit; no stored data or settings change.
- Abort if the live test shows misaligned masks; then fall back to the "refuse the capture" option, which needs no image work.

## Parts

### Part 1: Engine can list windows and paint rectangles black

- [x] Add `onScreenWindows` script and engine method. Done when an engine test shows the method parses the script output and rejects a bad shape.
- [x] Add `hide` to `compose`, `screenshot`, and `zoom`. Done when engine tests show: empty `hide` runs today's commands; non-empty `hide` composes the raw capture with the rectangles, skips `sips`, and deletes all files; the existing front-app test passes `hide: []`.
- [x] Both new and changed scripts compile. Done when the "%s compiles" tests pass for every script.

### Part 2: The read path blacks out hidden apps

- [x] Fake engine gains `onScreenWindows` and records `hide`. Done when existing mcp tests still pass.
- [x] mcp.ts lists hidden windows before and after a display capture and passes them. Done when the acceptance criteria above (except the live one) each have a test that fails before the change.

### Part 3: Docs and live check

- [x] OVERVIEW.md and README.md state the new behavior and the over-masking. Done when the version test (which reads README) passes and the text matches the code.
- [x] Opt-in live test checks a masked pixel is black. Done when M runs `npm run test:live` and it passes (M's call: it opens and closes a scratch TextEdit document).

## Standardized review

### At a glance

- **Bottom line:** present as is
- **Where we are:** reviewed this plan against the current code; complete; waiting on nothing
- **Need from M:** nothing for the review; the plan itself needs sign-off
- **Why:** every current-system claim was checked against the source, and the one race and the over-masking are stated as accepted limits
- **Intended outcome:** password managers and user-hidden apps never appear in full-display screenshots, while screenshots keep working
- **Findings:** 0 blocking, 0 must-verify, 2 notes

### Findings

#### 1. NOTE: A window that opens and closes within one capture is not masked

- **Why it matters:** one frame could show a hidden app's window.
- **Recommendation:** accept and document; the before-and-after comparison closes every case where the window stays open.
- **Need from M:** Nothing.
- **Criterion:** Failure and recovery. **Fix:** server/mcp.ts capture helper, as designed.

#### 2. NOTE: The live check needs M to run it

- **Why it matters:** pixel alignment of the mask is only proven on a real display.
- **Recommendation:** M runs `npm run test:live` after Part 3; if it fails, switch to the refuse option.
- **Need from M:** run the live tests after build.
- **Criterion:** Verification. **Fix:** Part 3 task 2.

### Criterion coverage

- **Goal fidelity: pass.** Goals match M's choice and the settings text at client/settings-screen.tsx:60, 63. Fix: None.
- **Current-system accuracy: pass.** Every "today" claim cites server/mcp.ts, server/engine.ts, or server/engine-scripts.ts lines that were read. Fix: None.
- **Scope and cohesion: pass.** ui_snapshot, front-app scope, and release are explicit non-goals. Fix: None.
- **Architecture and dependency direction: pass.** Policy stays in mcp.ts via `blockLevel`; the engine only lists and paints. Fix: None.
- **Sequencing and dependencies: pass.** Part 2 needs Part 1's engine contract; Part 3 needs both. Fix: None.
- **Completeness: pass.** Code, tests, docs, and the live check are covered; no data or migration. Fix: None.
- **Failure and recovery: violation.** The open-and-close race is accepted, not closed. Fix: Finding 1.
- **Verification: violation.** The pixel check runs only when M runs live tests. Fix: Finding 2.
- **Feasibility and precision: pass.** All named files exist; `onScreenWindows` is marked new. Fix: None.
- **Decision readiness: pass.** The only open choice (release) does not change the code. Fix: None.

### Scope and limits

- **Reviewed:** this plan, server/mcp.ts, server/engine.ts, server/engine-scripts.ts, server/test-engine.ts, server/engine.test.ts, the live test file.
- **Not reviewed:** Paseo host code; not needed.
- **Checks not run:** the live capture.
- **Ruled out:** Nothing.
- **Confidence:** high for the unit-testable parts; medium for mask alignment until the live test runs.

## Changes made

- Part 1: `onScreenWindows` script and engine method; `hide` on `compose`, `screenshot`, `zoom`; screencapture handling moved into `captureFile` so the masked path reuses it. Engine tests 33 of 33 pass; compose checked off-screen on assets/screenshot.png (hidden rectangle 0.000, outside pixels equal the source).
- Part 2: `hiddenWindows` and `hidingCapture` in server/mcp.ts; fake engine lists windows and records `hide`. MCP tests 89 of 89 pass; a mutant with the after-capture check disabled fails the race test.
- Part 3: OVERVIEW.md and README.md updated; opt-in live test added (run by M on 2026-11-03: 8 of 8 live tests passed). Full suite 233 passed, 8 skipped (live).

## Open questions

- Release: decided by M on 2026-11-03: bumped to 0.5.1.
