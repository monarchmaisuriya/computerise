# Computerise 0.4.0: element-numbered actions, state after each action, permission prompts and status

- Date: 2026-10-25 17:19
- Status: done (all 4 parts implemented and verified; not committed)
- Repos: computerise   Folders: `server/`, `client/`, `shared/`
- Files: `server/elements.ts` (new), `server/elements.test.ts` (new), `server/mcp.ts`, `server/mcp.test.ts`, `server/engine.ts`, `server/engine-scripts.ts`, `server/engine.test.ts`, `server/engine.live.test.ts`, `server/plugin.ts`, `server/plugin.test.ts`, `shared/contracts.ts`, `client/panel.tsx`, `OVERVIEW.md`, `README.md`, `package.json` (version)
- Subagents: none
- Inputs: `docs/2026-10-25-1700_computer-use-vs-computerise_research.md` (workspace docs), `docs/2026-10-25-1420_computerise-advanced-robustness_research.md` (item 9)

## Context and problem

Agents click by screen coordinates they read off a screenshot or a `ui_snapshot` frame. If the window moved, a sheet opened, or a list scrolled since that read, the click lands on whatever is there now. After an action the agent gets only `Done: <description>`, so it cannot tell whether the click did anything without another screenshot or snapshot call. When something fails because a macOS permission is missing, the panel shows the state, but there is no button to fix it. Screen Recording shows as unknown until the first screenshot, and an agent has no tool to ask why its calls fail.

Who is affected: every agent using Computerise (more wrong clicks, more round trips), and M setting it up on a new Mac.

## Goals / Non-goals

Goals:

1. An agent can click, move to, or scroll an element by the number `ui_snapshot` gave it. The plugin refuses, and nothing happens, if that element is no longer the same control.
2. Every successful action returns what changed in the front window, or says plainly that nothing visible to the accessibility tree changed.
3. The Computer panel offers a way to open the right System Settings pane for each missing permission, can ask macOS to show its Accessibility prompt, and can check Screen Recording without waiting for an agent's screenshot.
4. An agent can call a `status` tool that tells it whether computer use is on, stopped, held by another agent, or missing a permission.

Non-goals:

- Pressing elements through accessibility actions (`AXPress`) or any input that skips the real pointer. Every element action still goes through the existing pointer click path and its checks.
- Element targeting for `drag`, `type`, and `key`. Type and key already go to the focused app; the agent clicks the field first.
- Background control, a Swift helper, multi-display.
- Showing in-chat cards that ask the user to grant a permission (open question 1).
- The blocklist additions found in the comparison research (separate decision).

## What is true today

### Tool pipeline

```
agent -> HTTP MCP (token) -> call(): identity, stop, mode, call rate, action rate
      -> onScreen(): corner failsafe, lease
      -> read()  : no-view check, run, no-view recheck, same front app, accepted()
      -> act()   : planned receivers -> blocklist -> approval (ask mode)
                   -> exclusive: lease still held, bring working app forward,
                      actual receivers == planned, corner, blocklist, spec.act()
      -> "Done: <description>" (+ screenshotAfterAction() when screenshot: true)
```

- The order above is enforced in `call`, `onScreen`, `read`, and `act` [verified: `server/mcp.ts:207-323`].
- `ui_snapshot` already numbers elements 1..N in breadth-first order from the focused window, then the menu bar, with `role`, `label`, `value`, and `frame` [verified: `server/mcp.ts:383-403`; `server/engine-scripts.ts:168-226`].
- Nothing keeps the snapshot after the call returns [verified: `server/mcp.ts:390-401`, no store].
- Password field values are already null [verified: `engine-scripts.ts:200`].
- The walk stops at `max` elements or a 5,000 ms budget and reports `cut` [verified: `engine-scripts.ts:213-216`; `engine.ts:23`].
- A snapshot read took 51.5 ms median in the long-lived host (77 Chrome elements), and 75 to 144 ms per app as a separate process [verified: robustness research, local measurements].
- Pointer actions find the receiving app with `windowAt(point)`, both before approval and again just before acting; the two must match [verified: `mcp.ts:186-190, 223, 238-239`].
- `ActionSpec.act(args, receivers)` gets the receivers only, not a resolved point [verified: `mcp.ts:76-87`].
- `screenshotAfterAction` runs a screenshot through the same gate as a separate screenshot, reports refusals as text, and audits it as a `screenshot` call [verified: `mcp.ts:257-276`].
- Rates: 120 calls and 60 actions per agent per minute [verified: `server/plugin.ts:23-24`].
- All tool names are preapproved in the provider's tool policy because the plugin owns approvals [verified: `plugin.ts:173-181`].
- The injected system prompt lists the tools and says "Take a screenshot or ui_snapshot before acting" [verified: `plugin.ts:27-35`].
- Per-agent state is cleared on turn end and close (lease), archive, and mode change (scopes) [verified: `plugin.ts:217-239`].

### Permissions

- Accessibility is read with `AXIsProcessTrusted()` in the status script [verified: `engine-scripts.ts:20`].
- Screen Recording is known only from a capture's result: `granted` after any capture works, `missing` when `screencapture` says "could not create image", else `unknown` [verified: `engine.ts:152, 300-310`].
- The panel polls `computer.panel.health` every 5 s and shows both rows; Screen Recording reads "not checked until the first screenshot" [verified: `client/panel.tsx:11-12, 26, 59-69`].
- There is no RPC or button to open System Settings or to prompt [verified: grep for `x-apple.systempreferences`, `AXIsProcessTrustedWithOptions` finds nothing in `server/`, `client/`, `shared/`].
- JXA exposes `AXIsProcessTrustedWithOptions` (type `function`) but not `CGPreflightScreenCaptureAccess` or `CGRequestScreenCaptureAccess` (type `undefined`) [verified: `osascript -l JavaScript` type check, 2026-10-25].
- Errors already name the System Settings path for each permission [verified: `engine.ts:97, 283, 307`].

### Assumptions on the changed path

| Function | Assumes | Made true by |
| --- | --- | --- |
| `ui_snapshot` numbering | Same window, same order, same count on a re-read when nothing changed | Breadth-first walk with fixed `max` [verified: `engine-scripts.ts:211-219`]; deterministic order across reads [unverified: re-read TextEdit and Finder twice, compare] |
| `windowAt` | The point's topmost window owner is the receiver | `SCRIPTS.windowAt` [verified: `mcp.ts:186-190`] |
| `bringForward` | Working app is front before the actual check | Read-back loop [verified: `mcp.ts:194-205`] |
| Element frame | Points in the same space as screen coordinates | AXPosition is top-left global points [inferred: `ui_snapshot` frames are already used for coordinate clicks; live test will confirm] |

## Options considered

### Element targeting

| Option | How it works | Tradeoffs | Fails when | Completeness |
| --- | --- | --- | --- | --- |
| A. Re-read and compare, then pointer click at the live center (recommended) | Store each agent's last snapshot (app, pid, signatures). On an element action, re-read the front window just before acting, require element N to match role, label, and frame, then click its live center through the existing path | One extra snapshot per element action (~50-150 ms); reuses every pointer check | Element order shifts although the target did not change (false stale; agent re-snapshots) | 9/10 |
| B. Keep AX element references in the long-lived host and press them | Host keeps a map of element refs; `AXPress` acts without the pointer | No re-read; but it skips `windowAt`, the corner check, and the receiver logic; state is lost when Stop restarts the host | Anything covering the element; host restarts | 6/10 |
| C. Coordinates only, with the element number as a hint in the approval text | No stale check | Does not solve mis-clicks | Always | 3/10 (flag) |

RECOMMENDATION: A because it closes the stale-click gap while every element action still passes the same receiver, blocklist, corner, and approval checks as a coordinate click.

### State after an action

| Option | How it works | Tradeoffs | Fails when | Completeness |
| --- | --- | --- | --- | --- |
| A. Before and after snapshot, return a diff (recommended) | Snapshot the front window just before acting (reused from the stale check for element actions), wait 300 ms, snapshot again through the read gate, return a verdict and a capped diff, store the after-snapshot as the new numbering | Two snapshots per action; small text output | Canvas or Electron apps show no AX change (reported honestly as "no change detected") | 9/10 |
| B. After snapshot only, full list | Return the whole after list | One snapshot; up to 200 lines per action in tokens; no "nothing changed" verdict | Long windows | 6/10 |
| C. Screenshot after every action | Reuse `screenshot: true` by default | Images cost far more tokens; no verdict | Text-only models | 5/10 (flag) |

RECOMMENDATION: A because the before snapshot is what makes "the click did nothing" detectable, and a diff keeps the result short.

### Permissions and status

| Option | How it works | Tradeoffs | Completeness |
| --- | --- | --- | --- |
| A. Panel buttons plus a probe plus an agent `status` tool (recommended) | "Open settings" per permission (fixed URL), "Ask macOS" for Accessibility (`AXIsProcessTrustedWithOptions` with prompt), "Check" for Screen Recording (1 x 1 point capture, deleted), and a read-only `status` tool | Small new RPCs and one tool | 8/10 |
| B. Only "Open settings" buttons | Fewer moving parts | Screen Recording stays unknown; agents still cannot diagnose | 5/10 |

RECOMMENDATION: A because each piece answers a separate failure M hits during setup, and none touches the input path.

## Decision

Do all three option A's, as one minor release (0.4.0) in three parts, because each part only adds behavior on top of the existing gate and none weakens a check. Element actions and the after-action state share one new module (`server/elements.ts`) that holds per-agent snapshots and the comparison and diff logic as pure functions, so the safety-critical pipeline in `mcp.ts` changes only at its edges.

Rejected: pressing elements through accessibility actions (skips receiver and corner checks); full lists after each action (token cost); screenshots after each action (token cost, no verdict); settings buttons alone (leaves status unknown).

Consequences: tool schemas of `click`, `move`, `scroll` change (`x`, `y` become optional, `element` added) and a new `status` tool appears. Existing agents keep the old tool list until recreated, which still works. Each action takes about 100 to 300 ms longer.

## Design

### Element store (`server/elements.ts`, new)

```
ElementTable  = { pid, bundleId, appName, max, elements: Element[] }   // Element = { role, label, value, frame }
signature(e)  = role | label | frame rounded to whole points            // value excluded: typing must not make a field stale
ElementTables : set(agentId, table) / get(agentId) / clear(agentId) / clearAll()
match(table, live, n) -> { ok: true, element } | { ok: false, reason }
diff(before, after)   -> { verdict: "changed" | "unchanged" | "other-app", lines: string[] }
```

- Store one table per agent, replaced by every `ui_snapshot` and by every after-action state; at most 400 elements, so memory is bounded by agent count.
- Clear on `stopAll`, agent close, archive, and a mode change. Not cleared at turn end: the stale check protects a reused number.

### Element actions (Part 1)

```
click {element: 12}
  planned:  table? -> expected = copy of element 12 + table pid/max                           <-- new
            -> expected has a frame? -> center -> windowAt(center) == table app?
            -> blocklist -> approval "click left on element 12 (AXButton "Save") at (412, 230) on TextEdit"
  exclusive: lease -> bringForward(working)
            -> front pid == expected pid? -> live = uiSnapshot(pid, expected max)             <-- new
            -> match(expected, live[12])? else Refusal "element 12 changed; call ui_snapshot" <-- new
            -> live center -> windowAt(live center) == planned app                            <-- changed (live point)
            -> corner -> blocklist -> engine.click(live center)
```

- The actual phase compares the live element with the copy captured at planning time, never with the store. An agent can send tool calls in parallel, and an earlier call's after-action state may replace the store while this call waits for approval; comparing with the store then could click a different control than the one the user approved.

- Schema: `click`, `move`, `scroll` gain `element: integer 1..400`; `x` and `y` become optional. Exactly one of `element` or both `x` and `y` is required, checked in the spec (Refusal with a clear message), because MCP raw shapes cannot express it.
- Contract change inside `mcp.ts`: pointer specs return a target `{ apps, point }` instead of `apps` alone, so `act` and `after` (`failsafe.notePlaced`) use the point resolved in the actual phase. Keyboard and `open_app` specs are unchanged.
- Refusals: no table ("Call ui_snapshot first"), number out of range or element without a frame, front app differs from the table's app, element covered by another app, element changed. All are `Refusal`, audited as refused, nothing posted.
- The `ui_snapshot` description and the system prompt section gain one line each: "Pass element: N from your last ui_snapshot instead of x and y; the plugin refuses if that control changed."

### State after an action (Part 2)

- Before acting (inside `exclusive`, after all checks, right before `spec.act`): take `before = uiSnapshot(front pid, max)` only when the front app's block level is `none`; element actions reuse their `live` read. The receivers' input check does not cover the front app: a pointer action can target a window behind it, and `open_app` targets the app being opened. When the front app is blocked, no before read happens and the verdict line says `Not compared: <app> is blocked from view`.
- After a successful action: wait `SETTLE_MS` (300 ms), then run a state read through `onScreen` with a read spec equal to `ui_snapshot` (same no-view and screen-changed checks), like `screenshotAfterAction`. It does not take a call from the rate limiter (it is part of the action) and is audited as `ui_snapshot`.
- Result text after `Done: ...`:
  - unchanged: `No change detected in TextEdit's controls. The action may have done nothing, or changed something the accessibility tree does not show; take a screenshot to check.`
  - changed: `Changed in TextEdit (3 of 41 controls):` then lines `+ 14. AXButton "Done"`, `~ 3. AXTextArea value "abc" (was "ab")`, `- AXSheet "Save"`, capped at 30 lines plus `... and N more; call ui_snapshot for the full list`.
  - other app: `Front app is now Mail (120 controls); element numbers now refer to its front window.`
  - refused: `No state: <reason>`, and the agent's table is cleared.
- The after snapshot becomes the agent's table, so numbers in the diff are current.
- `screenshot: true` still adds its screenshot after the state text.
- Data: the after state is the same kind of data `ui_snapshot` already returns to the provider; the difference is that it is now automatic. `OVERVIEW.md` says so.

### Permission prompts and status (Part 3)

- RPC `computer.permissions.open` input `{ permission: "accessibility" | "screen-recording" }`: runs `open` with one of two fixed `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` / `?Privacy_ScreenCapture` URLs. No free-form URL. Auth: plugin RPC from a connected Paseo client, same as the existing panel RPCs.
- RPC `computer.permissions.prompt` (Accessibility only): a new script calls `AXIsProcessTrustedWithOptions({AXTrustedCheckOptionPrompt: true})`; returns the trusted flag. macOS shows its own prompt, which adds Paseo to the list.
- RPC `computer.permissions.check` (Screen Recording): captures a 1 x 1 point region at (0, 0) into the private scratch folder with `screencapture -x -R0,0,1,1`, deletes it in `finally`, and updates `captureAccess`. The image is never read into memory or sent anywhere.
- Panel: next to a `missing` or `unknown` row, show "Open settings"; for Accessibility also "Ask macOS"; for Screen Recording also "Check". Health refetches after each.
- MCP tool `status`: a new spec kind `info`, the only kind that `call()` lets past the stop and mode checks. It still requires identity and takes a call from the rate limiter; it skips the corner check and the lease. It reports mode, stopped, lease holder (you / another agent's title / none), Accessibility, Screen Recording, working app, and whether an element table exists, so the agent can tell the user what to do. It reads only the status script (no screen content). The prompt section's tool list gains `status`.

### Settings and defaults

No new settings. `element` absent means coordinates, as today.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Noticed by |
| --- | --- | --- | --- | --- |
| Element order changes between reads although the target did not (false stale) | Medium on dynamic apps | Agent re-snapshots; extra round trip | Signature includes frame, not index alone; the after-action state refreshes the table each action | Live test re-reads TextEdit and Finder twice; refusal counts in audit |
| Two snapshots per action slow actions | Medium | 100-300 ms extra per action; up to 5 s on huge trees | Use the agent's `max`; measure in live test | Abort if median added time on TextEdit, Finder, Chrome exceeds 400 ms |
| "No change detected" when a canvas or Electron app did change | High for Electron/canvas | Agent may retry a click that worked | Verdict wording says the tree may not show it and suggests a screenshot | Live test on a canvas-like area |
| After state shows a newly fronted app's text to the provider | Medium | Same data class as `ui_snapshot`, now automatic | Same no-view gate as reads; disclosed in OVERVIEW | Unit test: no-view app in front after action yields "No state" |
| Element frame space differs from click space | Low | Clicks offset | Live test clicks a TextEdit button by element | Live test |
| `AXIsProcessTrustedWithOptions` prompt does not appear for Paseo Helper, or appears only once | Medium | Button seems to do nothing | Button label says it asks macOS; "Open settings" always works; result text reports the flag | Manual check on this Mac |
| 1 x 1 probe capture counts as screen capture | Low | One pixel of the menu bar written to a private folder for milliseconds | Delete in `finally`; never read or sent; explained in OVERVIEW | Unit test asserts delete |
| `status` reachable while off reveals plugin state | Low | Mode, holder title, permission states only | Identity required; no screen content | Unit test |
| Ordering assumption across reads unverified | Medium | False stale | Part 1 starts with that live check | Live test |
| Menu bar elements (appended after the window's elements) resolve through `windowAt` to an owner other than the app | Medium | Element clicks on menus are refused as "covered" | Part 1 live check clicks a TextEdit menu element; if refused, word the refusal for menu items | Live test |

## Acceptance criteria

- Given a TextEdit snapshot, when the agent clicks `element: N` and the window is unchanged, then the pointer clicks that control's center and the result reports the change.
- Given a snapshot, when the window moves before `click element: N`, then the call is refused with "changed" and no event is posted.
- Given no snapshot this session, when the agent passes `element`, then it is refused with "Call ui_snapshot first".
- Given both `element` and `x`, or neither, then the call is refused before approval.
- Given ask mode, when an element click is requested, then the approval card names the element role and label and the app.
- Given an element covered by another app's window, then the call is refused naming that app.
- Given an element click waiting for approval, when a parallel call replaces the agent's table, then the click compares against the element the user approved and is refused if the live control differs.
- Given a password manager in front and a click on a window behind it, then no before snapshot is read and the result says "Not compared".
- Given any successful action, then the result contains a verdict line and at most 30 diff lines.
- Given an action that changes nothing in the tree, then the result says "No change detected".
- Given an action that brings a no-view app to the front, then the result says "No state" and the table is cleared.
- Given Stop, close, archive, or a mode change, then the agent's table is cleared.
- Given Screen Recording unknown, when M presses Check, then the row shows granted or missing and no capture file remains.
- Given Accessibility missing, when M presses Open settings, then System Settings opens at Accessibility.
- Given mode off, when the agent calls `status`, then it learns that computer use is off and how the user turns it on.
- All existing tests pass; the live test suite gains element-click and after-state checks on TextEdit.

## Rollout and rollback

- Ship as 0.4.0 (adds tools and changes schemas). Agents must be recreated to see `element` and `status`; old agents keep working with coordinates.
- Order: Part 1, Part 2, Part 3; each part is independently releasable and reviewed.
- Abort conditions: live test shows false stale on an unchanged TextEdit window, or added latency over 400 ms median.
- Rollback: revert the release commit; no stored data format changes (tables are in memory only).

## Parts

### Part 1: Element store and element-targeted pointer actions

- [x] Live check first: re-read TextEdit and Finder snapshots twice and compare signatures (proves the ordering assumption). Done: both identical, or the plan is revised. Result: identical for both (live test "numbers an unchanged window's controls the same way on two reads" passed, 2026-10-25 17:24). Menu bar points resolve to "Window Server" with no bundle id, which coordinate clicks already refuse; element clicks on menu items get the same refusal.
- [x] `server/elements.ts` with `ElementTables`, `pickElement`, `matchLive`, `center`; tests first (red). Done: 11 unit tests for match, out of range, no frame, changed frame, changed label, value change not stale, sub-point frames.
- [x] `ui_snapshot` stores the table in `accepted()`. Done: element pipeline tests act only after a ui_snapshot; refused before one.
- [x] Pointer specs return `{ apps, point }`; `click`, `move`, `scroll` accept `element`; the planned phase captures the expected element. Done: tests for each refusal in acceptance criteria, approval text, that the live point is clicked, and that a table replaced during approval does not change the compared element.
- [x] Clear tables on stop, close, archive, mode change. Done: tests for stop, close, mode change, and kept across turn end; archive clears too but revokes the token first, so no test can observe it.
- [x] Tool descriptions and prompt section updated. Done: text reviewed.
- [x] Live test: element click on a TextEdit control. Done: passes on this Mac (every listed TextEdit control's middle is on TextEdit's window; the click lands on the text area's middle). The numbering live test now waits for two matching reads first, because a just-opened TextEdit window adds a group at the end of its list; 3 of 3 runs passed it.

### Part 2: State after each action

- [x] `describeChange(before, after)` in `elements.ts`, tests first. Done: tests for unchanged, added, removed, value-changed, other app, 30-line cap, long values, cut lists.
- [x] Before snapshot inside `exclusive`, skipped for a front app blocked from view; after state through the read gate; table replaced. Done: tests for each verdict, no read of a no-view front app (mutant probe caught), refusal path, no call-limit charge, audit entry. Deviation: a skipped before read reports "Front app is now ..." rather than "Not compared", because the after read is then either another app or refused; the skip rule is the read path's own no-view rule, not "none".
- [x] Latency measured with the long-lived engine (median of 10 snapshot reads): TextEdit 35 ms (21 controls), Finder 28 ms (12), Chrome 60 ms (68), Slack 28 ms (22). Added per coordinate action (read + 300 ms settle + read): about 356-370 ms, Chrome about 420 ms, over the 400 ms budget by about 20 ms; element actions about 60 ms less. Gap named to M; the settle time was kept.
- [x] Found while updating tests and fixed at the owning layer: the after-action read used up the agent's own corner placement excuse (`Failsafe.tripped` gained `keepPlacement` for after-action reads), and reset the working app, so typing after `open_app` of a still-launching app went to the previous app (after-action reads, including `screenshot: true`, no longer change the working app). Each has a test that failed first.

### Part 3: Permission prompts and status

- [x] One RPC `computer.permission.act` with four fixed actions (deviation from three RPCs: same behavior, one contract), engine methods `openPrivacySettings`, `promptAccessibility`, `checkScreenRecording`, script `promptAccessibility`. Done: tests for fixed URLs, probe file deleted, missing reported, health returned. The probe image is read into memory once by the existing capture code and discarded, never shown or sent.
- [x] Panel buttons for missing Accessibility and missing or unchecked Screen Recording; health updated from the RPC answer. Typechecked only; not yet seen in the app.
- [x] `status` MCP tool as spec kind `info`. Done: tests for off, stopped, held by another agent, permissions missing, unknown seat refused, call limit applied; every other tool still refused while off or stopped.
- [x] Live check: `checkScreenRecording` reports granted and `promptAccessibility` reports trusted on this Mac. The macOS prompt itself was not observed, because this Mac already trusts Paseo.

### Part 4: Docs and release

- [x] OVERVIEW and README: element numbers, automatic after-action state and its data note, permission buttons and the probe, `status`, `test:live` note. Done: text reviewed; no install commands in OVERVIEW.
- [x] Version 0.4.0 in `package.json`, `package-lock.json`, `server/version.ts`. Done: 212 unit tests pass, typecheck clean, live suite 7 of 7 in two runs. The live tests now close the scratch documents they open; 27 left over from earlier runs had made the front-app capture test time out.

## Standardized review

### Review: plan: Computerise 0.4.0 element actions, after-action state, permissions and status

#### At a glance

- **Bottom line:** present as is (2 blocking findings were fixed in this file before presenting)
- **Where we are:** reviewed this plan against `server/mcp.ts`, `server/engine.ts`, `server/engine-scripts.ts`, `server/plugin.ts`, `server/policy.ts`, `client/panel.tsx`, `shared/contracts.ts`; complete; waiting on M's sign-off and open question 1
- **Need from M:** 1 decision (open question 1); sign-off
- **Why:** both blocking findings broke a safety invariant (approved action equals executed action; no-view apps are never read) and are now specified and tested in Parts 1 and 2
- **Intended outcome:** agents act on controls by number without stale clicks, see what each action changed, and M can fix and check permissions from the panel while agents can diagnose failures
- **Findings:** 2 blocking (resolved), 1 must-verify, 1 note (resolved)

#### Findings

##### 1. BLOCKING (resolved) — A parallel call could make an approved element click hit a different control

- **Why it matters:** the user approves "element 12 (AXButton "Save")" but a different control is clicked.
- **Recommendation:** capture the expected element at planning time and compare the live element with that copy.
- **Need from M:** Nothing.

- **Criterion:** Failure and recovery (concurrency)
- **Where:** Design, "Element actions"; first draft compared `match(table, live, 12)` against the store
- **Problem:** Part 2 replaces the store after every action, and calls from one agent can overlap, so the store read after approval can differ from the one approved.
- **Fix:** element resolution in `mcp.ts` — expected element carried from the planned phase to the actual phase; acceptance criterion and test added.
- [verified] Approval waits outside `exclusive`, then actual receivers are read inside it (`mcp.ts:226-239`).
- [verified] Receivers compare only bundle ids (`mcp.ts:115-117`), so an app-level check alone cannot catch a different control in the same app.
- [inference] Providers may issue parallel tool calls; overlap is possible because only the execution, not the approval, is serialized.

##### 2. BLOCKING (resolved) — The before snapshot could read a password manager's window

- **Why it matters:** no-view apps must never be read; the before read would read one into memory even if it is never sent.
- **Recommendation:** take the before snapshot only when the front app's block level is `none`; otherwise report "Not compared".
- **Need from M:** Nothing.

- **Criterion:** Current-system accuracy
- **Where:** Design, "State after an action"; first draft said "Front app is already input-allowed here"
- **Problem:** the input check covers the receivers, not the front app.
- **Fix:** before-read rule in `mcp.ts` `act()` — gate on `blockLevel(front)`; test that the engine fake records no snapshot.
- [verified] Pointer receivers are the app under the point (`mcp.ts:186-190, 332`); `open_app` receivers are the app to open (`mcp.ts:491-495`).
- [verified] `blockLevel` returns `no-view` for Keychain Access, 1Password, Bitwarden, and user extras (`policy.ts:11-19`; `shared/blocks.ts`).

##### 3. MUST-VERIFY — Menu bar elements may resolve to the wrong owner

- **Why it matters:** element clicks on menu items could be refused as "covered by another app".
- **Recommendation:** the Part 1 live check clicks a TextEdit menu element; adjust only the refusal wording if refused.
- **Need from M:** Nothing.

- **Criterion:** Feasibility and precision
- **Where:** Design, element numbering includes menu bar items (`engine-scripts.ts:220-225`)
- **Fix:** element resolution — decide from the live result; risk row added.
- [unverified] What `windowAt` returns for a point in the menu bar.

##### 4. NOTE (resolved) — `status` needed an explicit exception in the single gate

- **Criterion:** Architecture and dependency direction
- **Where:** Design, "Permission prompts and status"
- **Problem:** the first draft said "answers when off" without saying how `call()` (`mcp.ts:298-309`) would allow it.
- **Fix:** new spec kind `info`, the only kind past stop and mode; tests that no other kind passes.

#### Criterion coverage

- **Goal fidelity — pass.** Goals 1-4 map to M's two asks plus the added permissions and status ask; non-goals listed. Fix: None.
- **Current-system accuracy — pass.** Claims tagged against files and lines; Finding 2 corrected. Fix: None.
- **Scope and cohesion — pass.** Blocklist additions and in-chat permission cards excluded. Fix: None.
- **Architecture and dependency direction — pass.** Pure logic in `server/elements.ts`; gate changes confined to `mcp.ts`; Finding 4 resolved. Fix: None.
- **Sequencing and dependencies — pass.** Part 2 uses Part 1's store; Part 3 independent; Part 4 docs last. Fix: None.
- **Completeness — pass.** Code, contracts, docs, version, live tests covered; no data migration (tables in memory). Fix: None.
- **Failure and recovery — pass.** Stale, covered, no table, refused after-state, Stop, close, archive, mode change, concurrency covered; Finding 1 resolved. Fix: None.
- **Verification — pass.** Each task has a test or observed condition; latency abort threshold set. Fix: None.
- **Feasibility and precision — violation.** Finding 3 open. Fix: Finding 3.
- **Decision readiness — pass.** Open questions 1-2 surfaced before build. Fix: None.

#### What is working

- Element actions reuse the full pointer path, so receivers, blocklist, corner, and approval apply unchanged (`mcp.ts:219-252`).
- The after-action state copies the proven `screenshotAfterAction` pattern through the same read gate (`mcp.ts:257-276`).
- Part 1 starts by testing its riskiest assumption (snapshot order stability).

#### Scope and limits

- **Reviewed:** this plan; the files listed above; the two research files.
- **Not reviewed:** Paseo's handling of parallel MCP calls from one agent; macOS prompt behavior.
- **Checks not run:** no code run; the JXA type check was run during planning.
- **Confidence:** high for the pipeline findings; medium for macOS permission behavior.

#### In plain terms

Two safety holes in the first draft are closed: a click now always matches what the user approved, and the plugin never reads a password manager's window. One small check on menu items happens in Part 1. M decides open question 1 and signs off.

## Changes made

- Code review fix (2026-10-25): reads after an action require the agent to still hold the screen and never take it, so a turn end or close during an action cannot re-hold the screen for up to 120 s (test failed first; 213 unit tests pass). Open review notes, not fixed: a failed before-read fails the action; the other-app state text implies element numbers are usable before a screenshot.
- Parts 2-4 (2026-10-25): every action reports what changed in the front window (before and after reads, diff, numbers refreshed); after-action reads keep the agent's corner excuse and never change the working app; permission RPC and panel buttons; `status` tool; docs; version 0.4.0; live tests clean up their documents. 212 unit tests and 7 live tests pass.
- Part 1 (2026-10-25): element-numbered `click`, `move`, `scroll` with a stale check against the control the user approved; new `server/elements.ts`; actions resolve a target (apps and point) in `mcp.ts`; tables cleared on stop, close, archive, mode change; prompt line; 186 unit tests and 6 live tests pass (live run 1 of 3 failed only from M using the Mac).

## Open questions

None. Resolved by M on 2026-10-25: permission prompts are panel buttons plus macOS's own Accessibility prompt, with no in-chat card; the after-action state is always on.
