# Review: code: Computerise working tree (v0.5.2 plus the header mode control)

## At a glance

- **Bottom line:** ship after fixing 6 blocking
- **Where we are:** whole repo reviewed by three independent area reviewers; every blocking and must-verify candidate went to a fresh refuter; all nine stood; complete
- **Need from M:** pick which fixes go into v0.6.0; one decision on hotkeys (finding 7)
- **Why:** the new header misses background agents, and five older paths let an agent act after the user lowered its permission, without approval, or on a window it was not checked against
- **Intended outcome:** the user's mode choice and app blocks hold for every agent and every action, and the header sets every chat in the workspace
- **Findings:** 6 blocking, 2 must-verify, 13 notes

## Decisions needed

1. Which findings to fix for v0.6.0. Recommendation: 1 to 6 and 8 now, plus note 13 (it now affects every chat the header touches); 7 after M's rule choice and a live check; other notes later.
2. Finding 7 (global hotkeys): ask for every combo with cmd, ctrl or option even in auto mode, or refuse a list of known global hotkeys. Recommendation: ask for every modifier combo in auto, because the list of other apps' hotkeys is unknowable.

## Findings

### 1. BLOCKING: "Off for all chats" misses background agents in the workspace, and the label says "Computer off"

- **Why it matters:** a background child keeps ask or auto (ask still allows screenshots) while the header claims every chat is off.
- **Recommendation:** list agents with `includeBackground: true` in `client/mode-header.ts`; skip the server work when the mode is unchanged (note 13).
- **Need from M:** Nothing.
- **Where:** `client/mode-header.ts:88` (no `includeBackground`), `:27` (`setAll` uses that list).
- **Fix:** client membership query: include background agents.
- **Evidence:** [verified] Paseo v0.16.0-beta.2 `session.ts:5946-5950` hides background agents by default; `create-agent/intent.ts` places a background child in its caller's workspace; `server/plugin.ts:179-207` seats every agent; the SDK 0.13.0 accepts `includeBackground` (`@getpaseo/protocol/dist/messages.js:1020`). Refuter: stands.

### 2. BLOCKING: switching auto to ask can be lost while the RPC reports success

- **Why it matters:** the agent stays in auto (memory and disk) and acts without approval after the user asked for approval.
- **Recommendation:** in `ControlStore.setMode`, treat any lowering of permission (auto to ask, anything to off) as the safer, applied-first change.
- **Where:** `server/policy.ts:164-167` (`keepOnFailure = parsed === "off"`), `:197-205`.
- **Fix:** `ControlStore`: rank modes and apply any decrease eagerly.
- **Evidence:** [verified] scratch test with the real `ControlStore`: Stop, Off for another agent, or archive during the ask write each left A in auto in memory, on disk, and after reopen. REVIEW.md's premise "the loss is always toward the safer state" is false here. Refuter: stands.

### 3. BLOCKING: turning a chat Off, or auto to ask, does not stop an action already past its last check

- **Why it matters:** a click is posted, or up to about 20 s of typing continues, after the user turned the chat off; after a switch to ask it runs with no approval.
- **Recommendation:** re-check the mode immediately before `spec.act`, and interrupt the running engine step when the lease holder's permission is lowered.
- **Where:** `server/mcp.ts:330` (last check), `:337` (pre-read up to ~15 s), `:338` (act); `server/plugin.ts:282-290` (no interrupt).
- **Fix:** the act path and the mode RPC: one "may this agent act now" check at the post point, and interrupt on lowering.
- **Evidence:** [verified] fake-engine runs: Off during the pre-read gave "Done: click" with 1 click and 0 interrupts; ask gave a click with 0 approval rows; Off during a 2,000-character type did not interrupt. `server/mcp.test.ts:590-614` expects an already-running action to finish after a switch to ask; that expectation changes. Refuter: stands (typing lasts ~20 s, not 60 s).

### 4. BLOCKING: "Allow <app> this turn" granted on a late card carries into the next turn, and a stale click can run in the next turn

- **Why it matters:** pointer actions in that app run without asking in a later turn; a plain Allow on the late card executes the earlier turn's click.
- **Recommendation:** bind requests and scopes to a lease generation; check it before `scopes.allow` and before acting.
- **Where:** `server/mcp.ts:391-397` (lease, then awaits), `:308` (planning), `:313` (request registered), `:318` (scope granted), `:324` (lease check); `server/plugin.ts:257-259` (turn end).
- **Fix:** `ScreenLease`: a generation per take; every grant and act compares it.
- **Evidence:** [verified] fake-engine run: the turn ended during planning, the card appeared, "Allow TextEdit this turn" was refused for that click but the next turn's click ran with 0 cards. Variant: a plain Allow after the next turn took the lease executed the stale click. Refuter: stands. [unverified] that Paseo emits `turn_ended` during an in-flight call (the plugin already assumes it, `mcp.ts:316`).

### 5. BLOCKING: an MCP client timeout makes the agent retry an action the server still completes

- **Why it matters:** the action happens twice; in ask mode the user approves the retry believing the first failed.
- **Recommendation:** honor the request's abort signal: refuse to act once aborted, and interrupt a running step on abort.
- **Where:** `server/mcp.ts:465` (signal dropped), `:742-745`.
- **Fix:** `MacAgentTools.call`: take the SDK's `signal` and check it at the act point.
- **Evidence:** [verified] Claude Code times out HTTP MCP requests at 60 s by default (https://code.claude.com/docs/en/env-vars); Codex's `tool_timeout_sec` defaults to 60 s; Paseo v0.16.0-beta.2 sets neither. Approval waits up to 55 s, then execution adds seconds. The SDK aborts in-flight handlers on close (`@modelcontextprotocol/sdk` 1.32.2 `protocol.js:262-266`). Refuter: stands.

### 6. BLOCKING: an x/y pointer action can land on a window that appeared after the owner check

- **Why it matters:** a click, scroll or drag can reach a blocked app's window that appeared during the pre-read (up to ~15 s on a large tree).
- **Recommendation:** hit-test inside the `pointer` script just before `CGEventPost` and refuse if the owner differs, as the keyboard script does.
- **Where:** `server/mcp.ts:326` (`windowAt`), `:337` (pre-read), `:338`; `server/engine-scripts.ts:83-122` (no recheck).
- **Fix:** `pointer` script: verify the expected pid at post time.
- **Evidence:** [verified] ordering read; typical gap ~0.1 s (plan doc measured 51.5 ms snapshots), seconds only on huge trees. Refuter: stands.

### 7. MUST-VERIFY: the `key` tool can fire global hotkeys of blocked apps

- **Why it matters:** in auto mode `cmd+shift+space` can open 1Password Quick Access, or a user hotkey can run a Shortcut, while every check passes on the allowed front app.
- **Recommendation:** decide (see Decisions); then a live check with a scratch hotkey.
- **Need from M:** decision.
- **Where:** `server/keys.ts:47-53` (any combo), `server/engine-scripts.ts:131,146` (`CGEventPost` at the HID tap).
- **Evidence:** [verified] no combo filter. [unverified] that HID-tap events reach global hotkey matching (widely relied on, not run). Modifier clicks were ruled out: the pointer script posts no key-down. Refuter: stands for `key`.

### 8. MUST-VERIFY: desktop-level windows of a hidden app are never blacked out

- **Why it matters:** if the user hides Finder (or a desktop widget app), desktop icon names reach the model in display screenshots and zooms.
- **Recommendation:** drop `excludeDesktop` from `onScreenWindows` only.
- **Where:** `server/engine-scripts.ts:289-290`.
- **Evidence:** [verified] live JXA metadata: options 1 vs 1|16 drop Finder's 1512x982 desktop window. [inferred] the capture includes it. Opt-in only. Refuter: stands.

### Notes

10. `open_app` reports failure after opening when the lease was released (`server/mcp.ts:686`).
11. `bringForward` activates the working app before checking its block level (`server/mcp.ts:325`).
12. Paseo cannot be hidden: `policy.ts:26` returns before `extraNoView`.
13. `setModeRpc` cancels approvals, scopes, and element numbers even when the mode is unchanged (`server/plugin.ts:282-289`); the header now sends it to every chat.
14. On Paseo 0.13.x every new agent starts Off (no `labels` before 0.14.0, `plugin.ts:215-219`); the manifest allows `>=0.13.0`.
15. A detached child of an Off agent starts in ask (`plugin.ts:220-221`).
16. Deleted (not archived) agents keep seats and modes forever; reopen mints extra seats (`plugin.ts:194, 268-280`).
17. A refresh in flight at dispose can still notify (`client/mode-header.ts:44-45`).
18. The script host's memory grows ~9 KB per window-list read (measured); bounded by timeouts.
19. An unbundled process inside a no-view bundle is never no-view (`engine-scripts.ts:20-23`).
20. `open -b` and `activate` may pick another copy of a bundle id (`engine.ts:268`, `engine-scripts.ts:183-198`).
21. Typing rechecks the receiver every 20 units, so up to 19 units can reach a newly frontmost app (`engine-scripts.ts:131,152`).
22. A done click is reported "macOS dropped the input" if the user moves the mouse right after (`engine.ts:111-114`), inviting a retry.

## Criterion coverage

- **Correctness and invariants — violation.** Findings 1-6. Fix: Findings 1-6.
- **Modularity and cohesion — pass.** Policy, engine, MCP tools, and client are separate files with one job each (`server/policy.ts`, `server/engine.ts`, `server/mcp.ts`). Fix: None.
- **Dependency direction — pass.** Client talks to the server only through `shared/contracts.ts` RPCs. Fix: None.
- **Single source of truth — violation.** Header membership comes from the client's list rather than the seats the server enforces (finding 1). Fix: Finding 1.
- **Simplicity and YAGNI — pass.** No speculative features found. Fix: None.
- **Explicit boundaries and contracts — violation.** The MCP call ignores its cancellation contract (finding 5). Fix: Finding 5.
- **Composition and reuse — pass.** Keyboard receiver check is the model for finding 6's fix. Fix: None.
- **Failure behavior — violation.** Findings 2, 5, notes 10, 22. Fix: Findings 2, 5.
- **Data, security, and compatibility — violation.** Findings 4, 6, 7, 8; note 14. Fix: Findings 4, 6-8.
- **Verification — violation.** No test for a lowering during the pre-read, a late approval after turn end, or a window change at post time. Fix: each fix adds its test.
- **Operations — pass.** Audit log and panel record each action (`server/audit.ts`). Fix: None.
- **Comments and documentation — violation.** REVIEW.md's "always toward the safer state" is false (finding 2). Fix: update REVIEW.md with this review.

## What is working

- No script injection: model values travel only as one JSON argument (`server/script-host.ts:16,23-25`).
- Seats cannot be inherited or rebound (`server/plugin.ts:185-188`, `server/seats.ts:41-43`).
- Display captures recheck hidden windows after capture and refuse on change (`server/mcp.ts:206-211`).

## Resolution (2026-11-12, v0.6.0)

M chose: fix 1-6 and 8 plus note 13; finding 7 with "modifier combos ask in auto". Each fix has a test seen failing first; the checks were also removed one at a time (mutants) and each removal failed a test.

- **1:** `client/mode-header.ts` lists agents with `includeBackground: true`. [unverified live: the CLI cannot create a background chat]
- **2:** `ControlStore.setMode` applies any mode that allows less at once (`MODE_RANK`, `server/policy.ts`).
- **3:** `ComputerMcp.setMode` interrupts the lease holder's running step on a lower mode; `requireMayAct` runs again right before the input is posted (`server/mcp.ts`).
- **4:** each lease take starts a turn number; the card is not shown, no app is allowed, and nothing runs unless the agent still holds the screen in that turn (`Lease.holds`).
- **5:** tool calls are kept by seat and request id, so a client's `notifications/cancelled` (which arrives on another POST) withdraws the card or interrupts the step; a closed connection does the same.
- **6:** the `pointer` script hit-tests each point and compares bundle id and enclosing apps before the first event (live test).
- **7:** key combos with cmd, ctrl, or option ask in auto mode (`canBeGlobalShortcut`, `server/keys.ts`). Not run live against a real global hotkey.
- **8:** `onScreenWindows` no longer excludes desktop-level windows (live test sees Finder's desktop window).
- **Note 13:** setting a chat to the mode it already has changes nothing.
- Other notes remain open.

## Scope and limits

- **Reviewed:** all of `server/`, `client/`, `shared/`, entry files, manifest; Paseo v0.16.0-beta.2 and v0.13.0 host code where cited.
- **Not reviewed:** live macOS behavior for findings 6-8 beyond window metadata.
- **Checks not run:** `test:live`; a live hotkey test; a live background child.
- **Ruled out:** modifier clicks firing hotkeys (pointer script posts no key-down, `engine-scripts.ts:86-101`).
- **Depth and coverage:** deep; high tier 9 of 9 files, medium all, low skimmed.
- **Confidence:** high for 1-5 (reproduced or source-traced); medium for 6-8 (need a live run).

## In plain terms

Six defects let an agent act when the user said it should not, or let the new header skip hidden chats; each has a contained fix in the layer that owns it. The hotkey gap needs M's choice of rule. The notes can wait.
