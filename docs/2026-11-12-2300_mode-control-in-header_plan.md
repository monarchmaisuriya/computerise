# Move the computer-use mode control into the workspace header

- Date: 2026-11-12 23:00
- Status: in progress (part 3 of 3: release)
- Repos: computerise   Folders: client/, docs root files   Files: client/pills.ts (replaced), client/pills.test.ts (replaced), client/mode-header.ts (new), client/mode-header.test.ts (new), index.client.tsx, README.md, OVERVIEW.md, version files
- Subagents: none

## Context and problem

The "Computer asks" control sits in the composer row, next to "Attach". M wants it in the workspace header, beside Morphise's reminder (alarm clock) button. The composer row is crowded, and the header is where the other per-workspace controls are.

## Goals / Non-goals

Goals:
- The mode control appears in the workspace header, in the plugin button group, and no longer in the composer.
- M can still set Off / Ask / Auto for each chat separately, with the current mode visible.
- An open menu stays open while the 2-second refresh runs.
- Approval notifications keep working; they ride on the same refresh.

Non-goals:
- No change to how modes are stored or enforced on the server.
- No change to the Computer panel, `/computer`, or the Command Center items.
- No Paseo change. The registry PR is out of scope unless M asks.

## What is true today

- The composer pill is added per chat with `addComposerPill({ workspaceId, agentId })` [verified: client/pills.ts:52].
- A header button is added per **workspace** only: `PluginHeaderButtonContribution` is `{ id, workspaceId, button }`, with no agent [verified: paseo v0.16.0-beta.2 packages/plugin/src/client/buttons.ts:47-51]. It exists since Paseo v0.13.0, the plugin's minimum [verified: `git show v0.13.0:packages/plugin/src/client/contracts.ts` has `addHeaderButton`; paseo-plugin.json:7 `">=0.13.0"`].
- No plugin API tells a header button which chat tab is in front. Only sidebar views get `active.agent` [verified: v0.16.0-beta.2 contracts.ts:107; buttons.ts:6-8 header context is `{ context: "workspace"; workspaceId }`].
- Morphise's "Remind me" header button has the same gap and falls back to the workspace's first chat [verified: ~/.paseo/plugins/morphise/.../client/chats.ts:75-81, task-surfaces.tsx:84 passes `null`].
- Plugin header buttons render first in the header's right side, before scripts, Open in editor, Pull, and the explorer toggle [verified: v0.16.0-beta.2 workspace-screen.tsx `headerRight`]. Within the plugin group they keep registration order [verified: buttons/model.ts `publish([...this.entries, ...])`].
- Header and composer buttons share one store: an `update` that carries `behavior` closes an open menu [verified: model.ts `const close = !button.visible || button.disabled || patch.behavior !== undefined`].
- Menu items can open submenus [verified: view.tsx `buttonPages`, `hoverIntent: item.behavior.kind === "menu"`].
- On compact (phone-width) layouts a header button drops its label and chevron and shows only the icon [verified: view.tsx:250-257].

```
today:   poll (2 s) -> per chat: composer pill [Computer asks v]
after:   poll (2 s) -> per workspace: header button [Computer asks v]   <-- changed
                         menu: one chat  -> Off / Ask before actions / Automatic
                               2+ chats  -> "<chat title>: asks" > Off / Ask / Automatic
```

## Options considered

| | A: one header button, a submenu per chat (recommended) | B: one header button sets every chat in the workspace | C: guess the chat in front, like Morphise |
| --- | --- | --- | --- |
| How it works | Label shows the mode when all chats agree, else "Computer mixed". Menu lists each chat with its mode; each opens Off / Ask / Auto. One chat: flat menu. | Picking Auto sets Auto on every chat in the workspace. | Header acts on the first chat of the workspace. |
| Fits our code | Server already stores modes per chat; only the client changes. | Same server; client loops `setModeRpc`. | Same. |
| Cost | Small: one new client module. | Smallest. | Smallest. |
| When it fails | Long chat titles make long menu rows. | Widens permission: one click gives Auto to chats M did not mean to change. | Silently changes the wrong chat's permission when 2+ chats are open. |
| Completeness | 9/10 | 6/10 (safety broadening) | 3/10 |

RECOMMENDATION: A, because it keeps permission per chat while matching what a workspace header can know.

## Decision

Option B, chosen by M on 2026-11-12. The header is a workspace surface and Paseo gives it no chat, so the control acts on the workspace: one pick sets every chat in it that has the computer tools. The menu names the scope ("for all 2 chats") so the widening is visible at the click. Rejected: A (per-chat submenus, M preferred one pick) and C (guessing the chat in front changes the wrong chat's permission).

## Design

- New `client/mode-header.ts`, replacing `client/pills.ts`, exports `contributeModeHeader(client, notices)`. Same agent subscription and 2-second poll as today.
- Each refresh groups chats that have a mode (`panelStatusRpc().modes`) by `workspaceId`.
  - No chat with a mode: remove that workspace's button.
  - Label: `Computer off | asks | auto` when all chats agree, `Computer mixed` otherwise.
  - Title (tooltip): `Computer-use mode for this workspace's chat`, or `... for all N chats in this workspace`.
  - Menu: `Off`, `Ask before actions`, `Automatic`; with two or more chats each ends in ` for all N chats`.
  - A pick calls `setModeRpc` for every chat of that workspace known at the last refresh, then refreshes. If any call fails, the action throws `Could not set <mode> for X of N chats`, which Paseo shows as a toast.
- Update rule, to keep an open menu open: the menu changes only when the chat count changes, so `behavior` is resent only then. A label change sends text only. No change sends nothing.
- New chats keep starting in ask mode (server default, unchanged), so the label reads "Computer mixed" until the next pick.
- Icon stays `MonitorCog`. Button id `computer-mode`.
- `index.client.tsx` calls `contributeModeHeader` instead of `contributePills`.
- README.md:41-50 and OVERVIEW.md:11: "composer pill/control" becomes "the Computer button in the workspace header".
- Version 0.6.0: a visible UI move. Same files as v0.5.2's bump.
- No new config, routes, RPCs, or permissions.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Noticed by |
| --- | --- | --- | --- | --- |
| A chat is created, renamed, or changes mode while the menu is open, so the menu closes | Low | Low | Only content changes resend the menu | Test: unchanged refresh sends no update |
| Order next to Morphise's reminder can flip if Morphise re-registers its buttons | Medium | Low | Both sit in the same plugin group, so they stay adjacent; Paseo gives no ordering control | Live check |
| On phone-width layouts only the icon shows, so the mode is not visible at a glance | Certain on compact | Low | The menu still shows each chat's mode | Live check at compact width |
| Approval notifications break during the move | Low | Medium | Keep the notifier call in the same refresh; keep its test | Test |

## Acceptance criteria

- Given a workspace with one chat in ask mode, when the header renders, then it shows "Computer asks" and the composer shows no Computerise pill.
- Given two chats in a workspace with different modes, when the header renders, then it shows "Computer mixed"; when M picks "Automatic for all 2 chats", then both chats are auto and chats in other workspaces are unchanged.
- Given an open header menu, when the 2-second refresh finds no change, then the menu stays open.
- Given an approval waits, when the refresh runs, then one desktop notification names the chat (unchanged behavior).

## Rollout and rollback

Release v0.6.0 (M runs `gh release create`, as before), then `paseo plugin update computerise` on M's daemon. Rollback: update back to `--ref v0.5.2`. No stored data changes, so rollback is clean.

## Parts

### Part 1: Header control
- [x] `client/mode-header.ts` + `client/mode-header.test.ts`, red before green. Done: tests cover one chat, mixed chats, setting all chats, other workspaces untouched, partial failure, no-change refresh, chat count change, last chat removed, notifications, refresh failure logging.
- [x] Delete `client/pills.ts` and `client/pills.test.ts`; switch `index.client.tsx`. Done: `grep -rn contributePills` finds nothing.
- [x] README/OVERVIEW wording. Done: no "composer pill" left.
- [x] Live check on a throwaway 0.16.0-beta.2 daemon web UI. Done: button in header, submenu works, menu stays open past 2 s.

### Part 2: Whole-codebase review and fixes
- [x] `/review` code rubric over the whole repo; refute each blocking or must-verify finding with an independent subagent. Done: review brief with findings.
- [x] Fix confirmed findings after M picks which. Done: tests and typecheck green.

### Part 3: Release and reinstall
- [ ] Bump to 0.6.0, commit (M's go), tag, push, M runs the release command. Done: release URL.
- [ ] Update the plugin on M's daemon. Done: `paseo plugin ls` shows v0.6.0 commit; header shows the button.

## Standardized review

Plan rubric, reviewed by the author against the repository and Paseo v0.16.0-beta.2 source.

- Bottom line: usable; M picked option B. No blocking findings.
- Goal fidelity: pass; the move is the goal, and the per-chat mode is kept.
- Current-system accuracy: pass; every claim above carries a file reference.
- Scope: pass; server untouched.
- Architecture: pass; the control lives where Paseo gives workspace scope, and names chats explicitly instead of guessing.
- Sequencing: pass; build, then review, then release.
- Completeness: pass; docs, version, and rollback included.
- Failure and recovery: pass; open-menu closing and notifier carry-over are covered by tests.
- Verification: pass; each task has a done condition, with a live check for the host rendering.
- Decision readiness: A vs B surfaced and decided by M.
- Notes: header order versus Morphise is not controllable by a plugin; compact layouts show the icon only.

## Changes made

- Part 1: `client/mode-header.ts` replaces `client/pills.ts`; one header button per workspace sets every chat with the computer tools. Tests 9 of 9 (whole file red first; three mutants each caught). Full suite 252 passed, 10 skipped; typecheck clean. Live on a throwaway 0.16.0-beta.2 daemon: header shows the mode, composer pill gone, "Computer mixed" after `/computer off` on one of two chats, menu stayed open 7 s, "Automatic for all 2 chats" set both, the other workspace stayed "Computer asks", no console errors.

- Part 2: whole-codebase review at `docs/2026-11-12-2330_whole-codebase_review.md`: 6 blocking, 2 must-verify, 13 notes, all candidates refuted independently and standing. M chose to fix 1-6, 8, note 13, and 7 as "modifier combos ask in auto"; all fixed with failing-first tests and mutant probes. Suite 264 passed, 12 skipped; live suite 12 of 12 on this Mac; header rechecked live on the throwaway daemon. Version 0.6.0.

## Open questions

None. M chose option B and commits straight on main.
