# Review: code: Computerise v0.3.1

## At a glance

- **Bottom line:** ship as is
- **Where we are:** an independent reviewer read the v0.3.0 change (`2acf73d..c379db7`) cold; every finding was checked against the code or measured, then fixed with a test that failed first; complete
- **Need from M:** nothing
- **Why:** the one blocking finding and every confirmed must-verify finding are fixed at their owners; one finding was disproved by measurement and its remaining gap closed; live tests then exposed a deprecated macOS capture call that had started blocking, which was replaced
- **Intended outcome:** v0.3.0's speed and controls without any path that skips the safety checks
- **Findings:** 0 blocking, 0 must-verify, 0 notes open

## Findings and resolutions

1. **Blocking — the screenshot an action returns skipped Stop, mode, corner, lease, and rate checks.** It now goes through the same checks as a separate screenshot. Tests: turning the agent off, pressing Stop, or pushing the pointer into the corner during the action each yield "No screenshot" with the reason, and no capture.
2. **Must-verify — typed keys could reach an app that came forward after the check.** The premise that the long-lived host lags was disproved: it saw an app switch at 35 ms, before `lsappinfo` and the Accessibility focused app (about 71 ms). The underlying gap was real and predates v0.3.0: keys go to whatever app is in front, and typing 2,000 characters takes about 20 seconds. The keyboard script now receives the app the pipeline checked and verifies it before the first key and every 20 characters, stopping with a count, never the text. Live test: typing to an app that is not in front is refused before any key is posted.
3. **Must-verify — a drag between two apps ran without asking once each app was allowed.** Offering and using "Allow <app> this turn" now share one rule (`singleApp`), so a drag across two apps always asks.
4. **Must-verify — an approval answered after the turn ended still acted.** Pending requests are withdrawn on turn end, close, archive, and mode change; an approved action also checks that its agent still holds the screen before acting.
5. **Must-verify — the panel's Stop button waited behind long engine calls.** Panel status no longer touches the engine; health is its own RPC and query. Test: panel status and Stop answer while the engine hangs.
6. **Note — front-app capture might report Screen Recording granted when it is not.** Superseded by the capture change below: a failed window capture now names both possible causes (the window closed, or the permission is missing) and leaves the panel's state unknown instead of guessing.
7. **Note — script host failure paths.** A killed host's late error output no longer leaks into the next host's errors. Requests are sent as ASCII-only JSON, because the host decodes each pipe read separately and a character split across two reads stopped it; a 120,000-character non-ASCII request now round-trips (the test failed before).
8. **Note — Stop did not interrupt the running step.** Stop now kills the running host request, so a long piece of typing ends at once; the next call starts a new host.
9. **Note — panel contract changed for a cached client.** No action: client and server ship together in the plugin.

## Found by the live tests

- **Front-app-only screenshots blocked.** `CGWindowListCreateImage`, which Apple made obsolete in macOS 15, began blocking for every window (killed after 15 seconds, for TextEdit and Paseo alike), while `screencapture -l` captured the same window in 81 ms. Each window is now captured with `screencapture -l` and drawn onto the black canvas at its position; there is still no fallback to the full display. Verified by eye: only TextEdit's windows, at their positions, in 268 ms.

## Criterion coverage

- **Correctness and invariants — pass.** 164 tests by default and 4 live tests pass; each finding has a test that failed before its fix.
- **Modularity and cohesion — pass.** The receiver check lives in the keyboard script that posts keys; scope rules live in `approvals.ts`; deadlines and interrupts live in `ScriptHost`.
- **Dependency direction — pass.** The pipeline uses the engine interface; the engine uses the `ScriptRunner` seam.
- **Single source of truth — pass.** One `singleApp` rule for granting and matching scopes; one gate for all screen reads.
- **Simplicity and YAGNI — pass.** The deprecated call was replaced by an existing system tool, not a native helper.
- **Explicit boundaries and contracts — pass.** Keyboard input carries a validated receiver bundle id; host requests are ASCII-only.
- **Composition and reuse — pass.** The after-action screenshot reuses `onScreen`, not a copy of its checks.
- **Failure behavior — pass.** Withdrawn approvals, lost leases, front-app changes, and capture failures all refuse with a reason.
- **Data, security, and compatibility — pass.** Typed text stays out of logs and errors; tool schemas are unchanged.
- **Verification — pass.** Unit tests, live tests on macOS 26.7.1, and a provider run after reinstall.
- **Operations — pass.** Panel controls never wait for the engine; Stop interrupts the engine.
- **Comments and documentation — pass.** README and OVERVIEW describe the new limits and behavior.

## Scope and limits

- **Reviewed:** the full v0.3.0 change and its follow-up fixes; the installed plugin.
- **Not reviewed:** Paseo host internals; whether Paseo fires turn end while a tool call is pending (the fix holds either way).
- **Checks not run:** capture with Screen Recording revoked; multi-display; a stuck mouse button if Stop interrupts a drag mid-way (a drag lasts about 0.4 seconds).
- **Confidence:** high.

## In plain terms

The independent review found a real hole: the screenshot returned with an action skipped the safety checks. That and every other confirmed finding is fixed with a test. One worry, a stale front app, was disproved by measurement. While testing, a deprecated macOS capture call stopped working; it has been replaced.
