# Review: code: Computerise v0.2.0

## At a glance

- **Bottom line:** ship as is
- **Where we are:** reviewed the complete plugin, its tests, package, runtime installation, provider smoke tests, and SemVer compatibility; complete; waiting on nothing
- **Need from M:** nothing
- **Why:** eleven structural findings were fixed at their owning layers, including persistence fail-open behavior, read privacy races, stale approvals, archive revocation, execution-time safety rechecks, dependency advisories, and settings migration
- **Intended outcome:** a safe-by-default macOS computer-use plugin whose v0.2.0 release accurately communicates its compatibility and security contract
- **Findings:** 0 blocking, 0 must-verify, 0 notes after fixes

## Findings fixed

1. Control and seat stores no longer expose enabling state before durable writes succeed; safer Off, Stop, and revocation transitions remain effective even when persistence fails.
2. Screenshot and accessibility reads re-check the foreground app after capture and drop results when the screen changed or a no-view app appeared.
3. Every action re-checks Stop, mode, the corner failsafe, current settings, and the actual target immediately before engine execution.
4. A plugin-created move to the top-left corner exempts only the next check rather than disabling the emergency stop indefinitely.
5. Approval timeouts start after the row is visible, and final states are sequenced after the initial append so a slow pending row cannot overwrite cancellation.
6. Typed text never enters audit or panel history, including when an engine error echoes the text.
7. Read and action calls are rate-limited per agent; action calls retain the tighter limit.
8. Existing token-secret and data-directory permissions are repaired to `0600` and `0700`.
9. Archiving revokes seats, saved modes, leases, and rate state.
10. Built-in safety blocks are mandatory; version-1 settings migrate to version 2 and drop the removed escape hatch.
11. Vitest was upgraded from 3.2.7 to 4.1.12, removing all reported dependency advisories.

## Criterion coverage

- **Correctness and invariants — pass.** The full tool pipeline and its failure paths are covered by 119 passing tests and a live v0.2.0 TextEdit smoke test.
- **Modularity and cohesion — pass.** Engine, policy, identity, approvals, audit, panel state, client surfaces, and shared contracts retain separate owners.
- **Dependency direction — pass.** Client and server depend on shared validated contracts; server-only Node code does not enter the client bundle.
- **Single source of truth — pass.** Package SemVer is checked against the MCP-advertised version; built-in blocks have one shared owner.
- **Simplicity and YAGNI — pass.** The implementation keeps one local MCP endpoint and fixed macOS engine without adding an external driver.
- **Explicit boundaries and contracts — pass.** MCP inputs, RPCs, settings, persisted files, bundle IDs, keys, coordinates, and limits are validated.
- **Composition and reuse — pass.** Paseo settings, timeline, panel, lifecycle, and MCP SDK contracts are used directly.
- **Failure behavior — pass.** Invalid input, write failure, timeout, concurrent agents, Stop/Off races, stale screens, archive, and plugin cleanup fail closed.
- **Data, security, and compatibility — pass.** Tokens are HMAC-authenticated, secrets are mode-repaired, typed content is excluded from logs, settings migrate explicitly, and v0.2.0 truthfully signals the pre-1.0 contract tightening.
- **Verification — pass.** Regression tests saw red before fixes; full suite, typecheck, audits, package dry run, plugin reload, and live model smoke tests passed.
- **Operations — pass.** The plugin logs actionable startup failures, caps request and audit sizes, rotates audit output, and exposes Stop/Resume plus recent safe summaries.
- **Comments and documentation — pass.** README and OVERVIEW describe permissions, provider data flow, mandatory blocks, sandbox limits, and the full-display screenshot limitation.

## What is working

- The MCP endpoint authenticates per-agent seats, binds to loopback, validates tool schemas, and audits calls without typed text.
- The action pipeline serializes access, re-focuses the working app, re-checks target ownership and safety policy, and verifies pointer delivery.
- Claude, Codex, OpenCode, and a post-review OpenCode v0.2.0 smoke agent all completed exact TextEdit readback and screenshot delivery without MCP timeouts.

## Scope and limits

- **Reviewed:** every source and test file, package and lockfile, public documentation, live plugin loading, and provider acceptance behavior
- **Not reviewed:** Paseo host internals and Apple framework implementations beyond their documented/runtime-observed contracts
- **Checks not run:** physical iOS/Android rendering; client code passed the mobile static audit and compact-layout contract
- **Depth and coverage:** deep; high tier 10 of 10 files, medium 13 of 13, low/documentation 5 of 5
- **Confidence:** high; all findings have regression tests or live runtime evidence

## In plain terms

The review found and fixed real safety, privacy, concurrency, lifecycle, dependency, and compatibility defects. Computerise v0.2.0 is ready to release, with mandatory built-in blocks and explicit migration from v0.1.0 settings.
