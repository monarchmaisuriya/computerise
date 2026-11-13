# Let approvals wait up to 30 minutes

- Date: 2026-11-13 13:00
- Status: done (part 3 of 3)
- Repos: computerise   Folders: shared/, server/, client/, docs root files   Files: shared/contracts.ts, client/settings-screen.tsx, client/settings-draft.ts, server/tokens.ts, server/plugin.ts, server/mcp.ts, server/policy.ts, tests, README.md, OVERVIEW.md, version files
- Subagents: none

## Context and problem

An approval card waits at most 55 seconds today (default 45). M wants the wait configurable: default 1 minute, up to 30 minutes. The trace on 2026-11-13 found no Computerise card that timed out (the sheet chat's two calls were refused at once), so this is a capability request, not a fix for that episode.

## Goals / Non-goals

Goals:
- A setting "Wait for an answer" from 5 seconds to 30 minutes, default 60 seconds.
- A card never waits longer than the agent's own MCP client will wait, so an action can never run after the agent was told it failed.
- Claude agents created from this version on can actually wait the full setting.

Non-goals:
- No Paseo change. Codex agents stay capped at about a minute (see below).
- No change to what asks, or to auto mode.
- Agents created before this version are not upgraded; they keep the 55-second cap.

## What is true today

- The setting is `approvalTimeoutSeconds`, 5 to 55, default 45 [verified: shared/contracts.ts:10]. M's saved value is 45 [verified: ~/.paseo/plugin-settings/computerise/computer.json], so a new default does not change it.
- Claude Code times out each HTTP MCP request after 60 seconds unless `MCP_TOOL_TIMEOUT` is set above 60000 ms, and aborts a call that sends no response and no progress notification for 5 minutes unless `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` is raised (capped at `MCP_TOOL_TIMEOUT`) [verified: https://code.claude.com/docs/en/env-vars; installed Claude Code 2.1.322].
- Paseo passes Claude only `type`, `url`, `headers` for an HTTP server, so a per-server `timeout` from the plugin is dropped [verified: Paseo v0.16.0-beta.2 claude/agent.ts:1119-1124].
- The plugin's `agent.create` env is applied last over Paseo's provider runtime env, and is saved with the agent and reused on reopen [verified: v0.16.0-beta.2 provider-launch-config.ts:233, agent-manager.ts:1545,1587,1515,1678].
- Codex's limit is `mcp_servers.<id>.tool_timeout_sec`, default 60 s [verified: https://learn.chatgpt.com/docs/config-file/config-reference]; Paseo never sets it for HTTP servers [verified: codex-app-server-agent.ts:947-951]. No plugin lever found.
- The plugin's MCP HTTP server sets no `requestTimeout` [verified: server/mcp.ts:765]; Node's default is 300 s [inferred: Electron 44 bundles Node 22 or later].
- The screen lease frees itself after 120 s without a call [verified: server/plugin.ts:23]; since v0.6.0 an action whose lease turn changed is refused (`Lease.holds`), so a wait over 120 s would end in "The screen was released".
- The seat token is signed by the plugin, saved in the agent's MCP headers, and presented on every call [verified: server/tokens.ts:8-37, server/mcp.ts:790].

```
card shown --> waits min(setting, this agent's client limit) --> answer or timeout
                         ^ from the token (new)                      |
lease kept alive while waiting (new) <-------------------------------+
Claude agent created now: env MCP_TOOL_TIMEOUT 31 min (new), progress every 30 s (new)
plugin HTTP server: request limit above 31 min (new)
```

## Options considered

| | A: per-agent cap carried in the token (recommended) | B: one setting for everyone |
| --- | --- | --- |
| How it works | At creation the plugin raises a Claude agent's MCP timeout and signs "this client waits up to 31 min" into its token; Codex and older agents carry no claim and are capped at 55 s | Every card waits the setting; agents whose client gives up rely on v0.6.0's cancellation |
| Fits our code | Token already carries the seat; one optional claim | No token change |
| Cost | Small: token claim, env, cap | Smallest |
| When it fails | Codex never gets long waits | If a client times out without closing the request or sending a cancel (unverified for both CLIs), the user can approve after the agent was told it failed: a double act |
| Completeness | 9/10 | 5/10 |

RECOMMENDATION: A, because it never waits past what the agent's client will wait.

## Decision

Option A, signed off by M on 2026-11-13.

## Design

1. **Setting** (`shared/contracts.ts`): `approvalTimeoutSeconds` 5 to 1800, default 60. Same key, settings version unchanged (no saved value changes meaning). Settings screen: "Wait for an answer (seconds)", hint "From 5 to 1800 (30 minutes). Default 60. Codex agents and agents created before v0.7.0 wait at most 55." `0`, empty, or text stays invalid, as today.
2. **Claude agents** (`server/plugin.ts`, `agent.create`): for `config.provider === "claude"`, add `MCP_TOOL_TIMEOUT=1860000` (31 min) to the env, unless the env already has a larger value. The idle timeout is not raised; instead (step 4) the plugin sends progress while waiting.
3. **Token claim** (`server/tokens.ts`): optional `waitSeconds` (the client's limit). Minted as 1800 for Claude agents from this version; absent means 55. Older plugin versions strip unknown claims, so tokens stay valid on rollback.
4. **Waiting** (`server/mcp.ts`, `server/approvals.ts`): the card waits `min(setting, claim)`. While it waits, every 30 s the call sends an MCP progress notification when the request carried a progress token, and keeps its lease turn alive (`Lease.keepAlive(agentId, turn)`, new), so neither Claude's 5-minute idle timer nor the 120-second lease lapses.
5. **HTTP server**: no change. Revised during build: Node's `requestTimeout` only limits receiving the request; a 3-second answer with a 1-second limit arrived fine [verified: local run, Node v24.22.1].
6. Docs and version: README and OVERVIEW say who can wait how long; version 0.7.0 (a setting's range widens; includes the header check mark).

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Noticed by |
| --- | --- | --- | --- | --- |
| Claude sends no progress token, so its 5-minute idle timer cuts waits over 5 min | Medium | Medium | Live check in the build; fallback: also set `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=1860000` | Live check |
| `MCP_TOOL_TIMEOUT` also lets the agent's other HTTP MCP servers run up to 31 min per request | Certain | Low | Idle timeout still cuts silent servers at 5 min; documented | README |
| Rollback to v0.6.x with a saved value over 55 makes settings invalid, so screen tools refuse | Low | Medium | Rollback note: set the wait to 55 or less first | Tools say settings are invalid |
| A long wait holds the screen for that agent; other agents are refused meanwhile | Certain | Low | Same as today within one turn; Stop still frees it | Panel shows the holder |
| Existing chats keep 55 s | Certain | Low | Hint and README say new chats are needed | Settings hint |

## Acceptance criteria

- Given a Claude chat created on v0.7.0 and a 10-minute setting, when an action asks and M answers after 6 minutes, then the action runs once and the agent reports it done.
- Given a Codex chat or one created before v0.7.0, when an action asks, then the card times out at 55 s at most, before the client's 60 s.
- Given any wait, when the lease's 120 s idle time passes during it, then the approved action still runs.
- Given the settings screen, when M enters 1801 or 4, then it is refused with the range.

## Rollout and rollback

Release v0.7.0, reinstall; new chats get the long wait. Rollback: set the wait to 55 or less, then update to `--ref v0.6.0`.

## Parts

### Part 1: Setting and cap
- [x] Schema, settings screen, token claim, cap `min(setting, claim)`. Done: tests for range, default, cap for Claude, Codex, and old tokens, each seen failing first.

### Part 2: Staying alive while waiting
- [x] Claude env on create, lease keep-alive, progress notifications (HTTP limit dropped, see Design 5). Done: tests for the env, keep-alive past 120 s, and progress sent; live check on a throwaway daemon with a Claude chat answering after 6 minutes.

### Part 3: Docs, release, reinstall
- [x] README, OVERVIEW, version 0.7.0, commit (M's go), tag, push, M runs the release, reinstall. Done: `paseo plugin ls` shows the new revision.

## Standardized review

Plan rubric, self-review against the repository and Paseo v0.16.0-beta.2 source.

- Bottom line: present as is; one decision for M (A vs B); one must-verify (progress token) with a fallback.
- Goal fidelity: pass. Configurable 1 to 30 minutes, default 1 minute, as asked.
- Current-system accuracy: pass. Every claim above has a source or file reference.
- Scope: pass. No Paseo change; Codex limit stated as a non-goal.
- Architecture: pass. The client limit lives in the token the plugin signs for that agent, so the server never guesses a client's limit.
- Sequencing: pass. Cap first (safe on its own), then the keep-alive pieces.
- Completeness: pass. Setting, env, token, lease, HTTP limit, docs, rollback.
- Failure and recovery: pass. Rollback hazard and Codex cap covered.
- Verification: pass. Live check covers the unverified progress-token fact.
- Decision readiness: A vs B surfaced.

## Changes made

- Part 1: `APPROVAL_TIMEOUT_SECONDS` (5 to 1800, default 60) in `shared/contracts.ts`, used by the schema and the settings parser; token claim `waitSeconds`; `Approvals.request` caps at `maxWaitMs`; each MCP call carries its token's wait (55 s without the claim). Tests red first; mutant "ignore the token" caught.
- Part 2: Claude chats get `MCP_TOOL_TIMEOUT=1860000` (a larger existing value is kept) and a 1800-second claim; a waiting card keeps the lease turn alive (`Lease.keepAlive`) and sends progress every 30 s when the client asked for progress. Tests red first; three mutants caught. Suite 273 passed. Live: the new chat's Claude process has `MCP_TOOL_TIMEOUT=1860000`; an `open_app` card waited from 07:43:00 to 07:49:51 UTC (past Claude's 5-minute idle limit) and the chat got "The user denied this action" when denied, so Claude accepts the progress notifications.
- Header check mark (from the same session) and docs; version 0.7.0.
- Part 3: v0.7.0 committed (`9eed6f7`), tagged, pushed; M published the GitHub Release on 2026-11-13; `paseo plugin update computerise --ref v0.7.0` moved M's daemon to `9eed6f7`, running. Registry PR getpaseo/plugins#2392 opened. M's saved wait stays 45 seconds until M changes it.

## Open questions

1. Option A (cap per agent) or B (one setting for all)?
