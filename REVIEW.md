# Review: code: Computerise v0.3.0

## At a glance

- **Bottom line:** ship as is
- **Where we are:** reviewed the v0.3.0 change (long-lived engine host, new tools, front-app capture, per-app approval, panel health) with its tests, live checks, and provider smoke tests; complete; waiting on nothing
- **Need from M:** nothing
- **Why:** six structural defects found during the build and the live provider tests were fixed at their owners before release, each with a test or live run that failed first
- **Intended outcome:** a faster engine and new controls that keep every v0.2.0 safety check in the same pipeline
- **Findings:** 0 blocking, 0 must-verify, 0 notes after fixes
- **Live provider tests (2026-10-25, macOS 26.7.1):** Claude (Sonnet 5.5), Codex (GPT-6-Luna), and OpenCode (Claude Sonnet 5) each ran cursor_position, open_app with a returned screenshot, wait, type, and ui_snapshot with no tool errors or timeouts; OpenCode also ran with front-app-only screenshots, and the image it received showed only TextEdit's windows on black. TextEdit's own autocorrect changed some typed words ("opencode" to "open code"); the posted keystrokes were exact.

## Findings fixed

1. **A long-lived host reported a stale front app.** Without running its event loop, the host kept answering with the app that was in front earlier, which every blocklist and screen-change check reads. The host now pumps the run loop before every request. Proven by a live test that compares the host with a fresh process across an app switch; removing the pump makes it fail.
2. **A short request could kill a long one.** Deadlines started when a request was queued, so the panel's 2-second status poll waiting behind 20 seconds of typing would time out and kill the host mid-typing. Requests are now sent one at a time and each deadline starts when its request is sent.
3. **Screenshots returned with an action were not audited.** They are now audited and shown in panel history as their own screenshot entries.
4. **The host printed a stray empty line when its input closed.** It now ends silently, and a test proves it exits by itself, so it never outlives the plugin process.
5. **Anthropic's API rejected two tool definitions.** `zoom` and `drag` used tuple schemas, which the SDK writes in draft-07 form; Anthropic validates against JSON Schema draft 2020-12, so an OpenCode agent on an Anthropic model failed every request (`tools.15.custom.input_schema: JSON schema is invalid`). This predates v0.3.0. Both now use fixed-length arrays with the same arguments on the wire, and a test validates every tool schema against the 2020-12 meta-schema. A fresh OpenCode agent on Claude Sonnet 5 then passed.
6. **The prompt note made a model assume the tools were off.** "They are refused until the user turns computer use on" led Codex to answer without calling any tool, although its mode was Automatic (zero audit lines). The note now says to call the tools and react to the refusal message; a fresh agent created after the change called them unprompted.

## Decisions taken under M's delegation

- Front-app-only screenshots are opt-in; the default stays the full display, as in v0.2.0.
- "Allow <app> this turn" covers clicks, moves, drags, and scrolls in one app only; typing, keys, and opening apps always ask; it clears on turn end, close, archive, mode change, and Stop.
- Not shipped: Electron accessibility via `AXManualAccessibility` (accepted by macOS but no effect on Paseo or Slack), held mouse buttons and keys (need release-on-Stop design), element-targeted presses, finance blocks, multi-display.

## Criterion coverage

- **Correctness and invariants — pass.** 155 tests (152 run by default, 3 live) cover the host protocol, queueing, restart, capture routing, the no-fallback rule, scopes, and clearing events.
- **Modularity and cohesion — pass.** `ScriptHost` owns process lifetime and deadlines; `MacEngine` keeps its interface; scopes live beside approvals.
- **Dependency direction — pass.** The engine depends on the `ScriptRunner` seam; the pipeline depends on the engine interface only.
- **Single source of truth — pass.** Script sources stay in `SCRIPTS`; the host compiles them in at start and never receives source over the pipe.
- **Simplicity and YAGNI — pass.** Unproven items were dropped rather than shipped behind flags.
- **Explicit boundaries and contracts — pass.** New RPC fields and settings are validated by shared schemas; old approval rows and settings parse with defaults.
- **Composition and reuse — pass.** Front-app capture reuses the read path's front-app checks; the after-action screenshot reuses the screenshot read.
- **Failure behavior — pass.** A host death or missed deadline fails the running and queued requests; front-app capture fails loudly instead of showing the full display.
- **Data, security, and compatibility — pass.** Tool additions are optional; typed text stays out of logs; v0.2.0 settings load unchanged.
- **Verification — pass.** Mutant probes killed for the run-loop pump and for scope clearing; live tests on macOS 26.7.1.
- **Operations — pass.** The panel shows Accessibility, Screen Recording, and engine errors, and fetches the screenshot only when it changes.
- **Comments and documentation — pass.** README and OVERVIEW describe the new tools, settings, approval scope, and Electron limit.

## Scope and limits

- **Reviewed:** every changed source and test file, the live engine, the installed plugin, and provider smoke tests.
- **Not reviewed:** Paseo host internals; Apple framework behavior beyond observed results.
- **Checks not run:** front-app capture with Screen Recording revoked (whether macOS returns no image or a blank one); multi-display.
- **Confidence:** high for the engine and pipeline; medium for front-app capture behavior when Screen Recording is missing.

## In plain terms

Computerise v0.3.0 is faster and adds controls without moving any safety check. The review found and fixed four real defects during the build, including a stale-state bug that would have weakened the blocklist.
