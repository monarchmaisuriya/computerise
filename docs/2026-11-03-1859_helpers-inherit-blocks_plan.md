# Apps inside a blocked app's bundle are blocked the same way

- Date: 2026-11-03 18:59
- Status: done (part 3 of 3)
- Repos: computerise   Folders: server/, shared/, client/, docs at the root
- Files: server/engine-scripts.ts, server/engine.ts, server/policy.ts, server/mcp.ts, server/test-engine.ts, server/policy.test.ts, server/engine.test.ts, server/mcp.test.ts, server/engine.live.test.ts, client/settings-screen.tsx, OVERVIEW.md, README.md
- Subagents: none

## Context and problem

The review of the 0.5.1 change found that the Passwords app's menu-bar helper is neither hidden nor blocked. macOS ships it as a separate app inside the Passwords bundle (`Passwords.app/Contents/Library/LoginItems/PasswordsMenuBarExtra.app`, bundle id `com.apple.Passwords.MenuBarExtra`). Blocks match the exact bundle id of the process that owns a window, so the helper gets level "none". When its popover is open, a full-display screenshot sends it to the model provider unmasked, and an agent in auto mode can click the helper's menu-bar icon.

The cause is general: the block list names apps, but some apps run windows under helper apps that have their own ids.

M chose (2026-11-03): a helper inherits its parent app's block.

## Goals / Non-goals

Goals:

- An app whose bundle sits inside a blocked app's bundle gets the strictest of its own level and every enclosing app's level, everywhere a level is checked: screenshot masking, the front-app read refusal, input refusal, the controls read, and open_app.
- This holds for built-in blocks and for the user's extra blocked apps.
- If the engine cannot read an app's enclosing bundles, it reports none. The app keeps the level its own id gives it, which is the 0.5.1 behaviour.

Non-goals:

- Helpers installed outside their parent's bundle (none found for the built-in password managers).
- Content a password manager draws inside another app's window (browser autofill overlays).
- A new settings field. Inheritance applies to the existing lists.

## What is true today

- Every block decision goes through `blockLevel(bundleId, settings)`. It matches exactly: `extraNoView`, then the built-in list, then `extraNoInput` [verified: server/policy.ts:14-22].
- The engine turns a process into a bundle id in four scripts. None of them reports the app's path or its enclosing apps:
  - `status`, the front app [verified: server/engine-scripts.ts:12-17];
  - `windowAt`, the window under a point [verified: server/engine-scripts.ts:46-52];
  - `onScreenWindows`, for masking [verified: server/engine-scripts.ts:270-274];
  - `resolveApp`, for open_app; this one knows the path [verified: server/engine-scripts.ts:156-175].
- `AppRef` is `{ bundleId, name }` [verified: server/policy.ts:10]. It is built from those script results at server/mcp.ts:225, 272, 299, 373, 503 and 682.
- Callers of `blockLevel`: masking (mcp.ts:201), the controls read (mcp.ts:234), input refusal (mcp.ts:266), and the read refusal before and after a capture (mcp.ts:292, 295) [verified: grep].
- Apps nested inside blocked apps on M's Mac [verified: `find` over each blocked app's Contents]:
  - Passwords: `PasswordsMenuBarExtra.app`.
  - 1Password: `1Password Launcher.app`. 1Password's helper apps (`1Password Helper*`, `1Password Browser Helper`) also live inside its bundle.
  - Xcode: Instruments, FileMerge, Accessibility Inspector, Create ML, Icon Composer, DeviceHub, Xcode Service, GPUToolsAgent.

```
process id -> NSRunningApplication -> bundleIdentifier ---------> blockLevel(id)
                                   -> bundleURL path              <-- new: enclosing .app ids
                                        -> enclosing .app bundles    -> blockLevel(app): strictest of all ids
```

## Options considered

| aspect | A: inherit every level | B: inherit only "no-view" | C: list each helper id |
| --- | --- | --- | --- |
| How it works | A nested app gets the strictest of its own and its parents' levels | Same, but a parent's "no-input" is not passed down | Add `com.apple.Passwords.MenuBarExtra` to the built-in list |
| Passwords helper | Hidden and blocked | Hidden and blocked | Hidden and blocked |
| Xcode's Instruments, FileMerge, Accessibility Inspector | Input blocked (new) | Unchanged: agents can use them | Unchanged |
| Rule M reads in settings | "Apps inside a blocked app are blocked the same way" | Needs an exception for input blocks | No rule; one id per helper |
| Future helper of any blocked app | Covered | Covered for hidden apps only | Not covered |
| Completeness | 9/10 | 7/10 | 6/10 |

RECOMMENDATION: A, because Xcode is blocked for input as a code-running app and Instruments can launch and attach to processes, so its nested tools belong under the same rule. One rule with no exception is also what the settings text can state truthfully.

## Decision

Decided by M on 2026-11-03: option A. An app inherits every block level of the apps whose bundles contain it, so Xcode's nested tools become input-blocked like Xcode.

## Design

Target behaviour: the engine reports, for every app it identifies, the bundle ids of the app bundles that contain it, innermost first. The policy combines them.

- **Engine scripts.** One shared JXA function, `enclosingBundleIds(path)`, is put into each of the four scripts by string interpolation.
  - It walks the path's components. For each prefix that ends in `.app` and is not the app's own path, it reads `NSBundle.bundleWithPath(prefix).bundleIdentifier`.
  - It skips prefixes without an id and returns the ids innermost first.
  - The path comes from `NSRunningApplication.bundleURL.path`; resolveApp already has it. A process with no bundle URL reports `[]`.
- **Engine schemas** (server/engine.ts). `front`, the `windowAt` owner, `onScreenWindows` windows and `resolveApp` each gain `within: z.array(z.string())`. A missing field fails the call. No silent default.
- **AppRef** becomes `{ bundleId, name, within: readonly string[] }`. Every place that builds one copies `within` from the script result.
  - The lease's working app and the element tables carry it unchanged.
  - Approval scopes and `sameApps` still compare `bundleId` only; a helper is refused before either is reached.
- **Policy** (server/policy.ts).
  - `blockLevel(app: { bundleId: string | null; within: readonly string[] }, settings)` returns the strictest of the levels of `bundleId` and of each id in `within`.
  - One id's level is today's rule unchanged. A null own id still counts as "no-input".
  - The order is none < no-input < no-view.
- **mcp.ts.** The five `blockLevel` calls pass the app or window instead of `bundleId`; the six places that build an `AppRef` copy `within`.
- **Docs.** The settings-screen text (client/settings-screen.tsx:60), README.md:25 and :58, and OVERVIEW.md:21 say that apps inside a blocked app's bundle, such as its menu-bar helper, are blocked the same way.
- **Config.** No new values. Empty `within` means the app's own id decides, which is today's behaviour.
- **Auth.** Unchanged: no new routes or tools. The checks stay in `read()`, `requireInputAllowed` and `hiddenWindows`.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Noticed by |
| --- | --- | --- | --- | --- |
| `bundleURL` is nil for some processes | Medium | That app keeps its own-id level (today's behaviour) | Reported as `[]`; the helpers in scope are bundled apps | Live test on the Passwords helper path |
| Path walk reads the wrong bundle (symlinked or translocated paths) | Low | A helper not covered | Uses the running app's real path; the live test checks the real nested path | Live test |
| Xcode's nested tools become input-blocked (option A) | Certain under A | Agents can't drive Instruments or FileMerge | M decides (Open question 1); the settings text states the rule | M's answer |
| Extra script work on every status call | Low | A few path checks per call; no bundle reads for an app that isn't nested | Bundle reads happen only for `.app` prefixes above the app itself | Suite timing; live test duration |
| A call site keeps passing a bare id | Low | That check ignores inheritance | The `blockLevel` signature change makes a bare id a type error | `npm run typecheck` |
| Front app is a helper (a menu-bar popover that takes focus) | Medium | Must be refused | `status` reports `within`, so `read()` refuses it | mcp test |

## Acceptance criteria

- Given an app with id `com.apple.Passwords.MenuBarExtra` and `within: ["com.apple.Passwords"]`, when its level is checked, then it is "no-view".
- Given a nested app whose parent is in `extraNoView`, when its level is checked, then it is "no-view".
- Given `within: ["com.apple.dt.Xcode"]`, when its level is checked, then it is "no-input" under option A, or its own level under option B.
- Given an app's own level is stricter than its parent's, when checked, then its own level wins.
- Given a full-display screenshot with a Passwords-helper window on screen, then that window is in `hide`.
- Given the front app is the Passwords helper, when a screenshot is asked for, then it is refused as blocked from view.
- Given a click on a Passwords-helper window, then it is refused as blocked for input.
- Given open_app resolves to an app inside a blocked bundle, then it is refused.
- Given a script result without `within`, then the engine call fails.
- Given the real path `/System/Applications/Passwords.app/Contents/Library/LoginItems/PasswordsMenuBarExtra.app` on M's Mac, when the shared JXA function runs, then it returns `["com.apple.Passwords"]` (opt-in live test).

## Rollout and rollback

- Part of the unreleased 0.5.1 (decided by M on 2026-11-03). Nothing is committed yet.
- Abort if the live test shows the path walk returns nothing on the real helper path; then fall back to option C.
- Rollback: revert the change. No stored data or settings format changes.

## Parts

### Part 1: Engine reports enclosing apps

- [x] Shared `enclosingBundleIds` JXA function added to status, windowAt, onScreenWindows and resolveApp. Done when the engine tests show `within` passed through for each script and a result without it rejected.
- [x] Opt-in live test runs the function on the Passwords helper's real path. Done when M runs `npm run test:live` and it returns `["com.apple.Passwords"]`. Ran on 2026-11-03 with `-t "names|posts pointer"` (the tests that do not switch apps): 3 of 3 passed, including the real helper path. The full live suite, which switches the front app, has not been run on this change.

### Part 2: Policy combines the levels

- [x] `AppRef` gains `within`; `blockLevel` takes the app and returns the strictest level. Done when the policy tests for the acceptance criteria fail before and pass after.
- [x] The five `blockLevel` calls in mcp.ts pass apps and the six `AppRef` builders copy `within`; the fake engine reports `within`. Done when the mcp tests for the helper screenshot, front-app refusal, click refusal and open_app refusal fail before and pass after, and typecheck is clean.

### Part 3: Docs

- [x] The settings text, README and OVERVIEW state the rule. Done when each says that apps inside a blocked app's bundle are blocked the same way, and the review's Finding 1 claim is now true.

## Standardized review

- **Bottom line:** present as is (after one wording fix, applied).
- **Intended outcome:** a helper app inside a blocked app's bundle is hidden and blocked exactly like its parent, at every check.
- **Findings:** 0 blocking, 0 must-verify, 0 open notes. The "six call sites" count was wrong (five `blockLevel` calls, six `AppRef` builders) and is corrected in Design and Part 2.

Criterion coverage:

- **Goal fidelity — pass.** It fixes the review's Finding 1 at the policy layer, with the non-goals stated.
- **Current-system accuracy — pass.** The claims are tagged against `server/policy.ts:14-22`, the four scripts, and the `blockLevel` and `AppRef` call sites. Each script runs in its own function scope (`server/engine-scripts.ts`, `hostProgram`), so the pasted helper cannot clash.
- **Scope and cohesion — pass.** Only identity reporting, the policy, call sites and docs change.
- **Architecture and dependency direction — pass.** The engine reports facts (enclosing ids). The policy alone decides levels.
- **Sequencing and dependencies — pass.** Part 1 adds a field nothing reads yet, Part 2 consumes it, Part 3 documents it.
- **Completeness — pass.** It covers code, tests, live check and docs. There is no data or settings migration.
- **Failure and recovery — pass.** A missing `within` fails the call. A nil bundle URL means today's behaviour. Rollback is a revert.
- **Verification — pass.** Every behaviour has a failing-first test. The path walk has a live check on the real helper path.
- **Feasibility and precision — pass.** The named files exist. `within` and the shared function are marked new.
- **Decision readiness — pass.** Two open questions are surfaced before build: the inherited levels and the version.
- **Reviewed:** this plan, `server/policy.ts`, `server/engine-scripts.ts` (status, windowAt, resolveApp, onScreenWindows, hostProgram), `server/mcp.ts` call sites, `client/settings-screen.tsx:60`, and the nested-app listing on M's Mac.
- **Checks not run:** nothing executed. This is a plan review.
- **Confidence:** high.

## Changes made

- Part 1 (2026-11-03): `ENCLOSING_APPS` (server/engine-scripts.ts) is pasted into status, windowAt, onScreenWindows and resolveApp; each engine schema requires `within`. On M's Mac, Instruments reports `["com.apple.dt.Xcode"]` and TextEdit `[]`.
- Part 2 (2026-11-03): `blockLevel` takes `{ bundleId, within }` and returns the strictest level; mcp.ts passes identities at all five checks and copies `within` at all six builders. A mutant that ignored `within` at masking and input refusal failed 2 mcp tests.
- Part 3 (2026-11-03): settings text, README (bullet and screenshots paragraph) and OVERVIEW state the rule.

## Open questions

None. Answered by M on 2026-11-03: inherit every level (option A); ship in the unreleased 0.5.1.
