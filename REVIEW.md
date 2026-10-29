# Review: code: Computerise v0.5.0

## At a glance

- **Bottom line:** ship as is
- **Where we are:** three independent reviewers read the whole plugin (v0.4.1 plus the change to ask by default) cold; every finding was checked against the code, and each fix has a test that fails without it; complete
- **Need from M:** nothing
- **Why:** every finding the new default caused is fixed at its owner, and so are the older defects with a bounded fix; three findings are deferred with their risk stated below
- **Intended outcome:** new agents start in ask mode, without giving any existing or child agent more access than before
- **Findings:** 0 blocking, 3 must-verify deferred, 2 notes deferred

## Decision

- **Existing agents stay off (M, 2026-10-29).** In v0.4.1 an agent with no saved mode was off. On its first start, v0.5.0 saves Off for every agent that already has the tools and no saved mode (`ControlStore.keepExistingAgentsOff`, marked by `version: 2` in `control.json`). Only agents created afterwards start in ask mode.

## Findings and resolutions

1. **An upgrade would have given every existing agent screen reading without asking.** Fixed by the one-time migration above. It also covers an unreadable `control.json`: every agent that has the tools starts off, as in v0.4.1.
2. **A child of an Off agent would have started in ask mode.** The parent is read from the `paseo.parent-agent-id` label that Paseo 0.14 passes to `session_open`. The agent is not registered yet at that point, so an API lookup would fail; a request without labels starts the agent off. The mode is saved before the seat is bound.
3. **The panel and composer pill showed a mode for agents that have no computer tools.** The status RPCs now return the enforced mode for every agent with a bound seat, and nothing for others. Clients no longer compute a default.
4. **Invalid settings fell back to defaults and dropped the user's extra blocked apps.** Tools that see or touch the screen now refuse while the settings are invalid; `status` still answers.
5. **An action queued in auto still ran after the agent was switched to ask.** The queued step now rechecks the mode before anything touches the Mac.
6. **A failed audit write after an action reported the action as failed.** The agent could retry and act twice. The write failure is now logged, and the result says what happened.
7. **A Stop or mode change during the approval timeout read was missed.** The request is now registered before any wait.
8. **An element action could hit a different unlabelled row, cell, or text at the same position.** Values are now compared for every role except text fields, text areas, and combo boxes, which change while typing.
9. **Display size came from the screen with keyboard focus.** It now comes from the primary display that `screencapture -m` and point coordinates use.
10. **Composing a front-app screenshot did not check that the file was written.** It now refuses with a clear error; JXA was checked to return real booleans.
11. **Test helpers shipped in the package; the README named the wrong release.** Both are excluded or fixed, and the version test now also checks the lockfile and the README line.

## Deferred

- **Must-verify: typing checks the front app, not the focused process.** Non-activating panels (Spotlight, Raycast) can hold keyboard focus while the checked app stays in front. Posting with `CGEventPostToPid` needs live tests against such panels first.
- **Must-verify: multi-display behavior.** Item 9 aligns the code, but nothing was run with a second display.
- **Must-verify: Screen Recording missing on recent macOS** may return the wallpaper instead of failing, which would mark the permission as granted. Not run with the permission revoked.
- **Note: a less-safe save can be lost when a safer one lands at the same time** (`ControlStore.save`, `Seats.bind`). The loss is always toward the safer state.
- **Note: the engine has no stopped epoch.** Today every await after the last stop check is a script request that Stop interrupts. A future non-script await would let one step run after Stop.

## Scope and limits

- **Reviewed:** all of `server/`, `client/`, `shared/`, the manifests, README, and OVERVIEW; Paseo 0.14.0's daemon code for how `session_open` is called.
- **Checks run:** 223 unit tests, typecheck, a revert check for every new test, and a JXA check of the write return value and the primary screen.
- **Checks not run:** `npm run test:live`; multi-display; Paseo 0.13 (whether it passes labels).
- **Confidence:** high for the policy and pipeline fixes; medium for the engine fixes, which were not run live.

## In plain terms

New agents now start in ask mode, while agents that existed before stay off, and so do children of an Off agent. The reviews also found and fixed seven older defects, each with a test. Three engine risks need a live desktop to test and are written down above.
