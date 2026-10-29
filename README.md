<img src="computerise.png" width="160" alt="Computerise logo">

# Computerise

Computer use for any Paseo agent on macOS. Computerise gives Claude, Codex, OpenCode, and other MCP-capable agents tools to see and control the Mac running the Paseo daemon.

Current release: **v0.4.0**. Computerise follows [Semantic Versioning](https://semver.org/); while the API is pre-1.0, minor releases may intentionally tighten configuration contracts.

## What it provides

- Screenshots and zoomed regions, optionally showing only the front app's windows
- Text accessibility snapshots for models that cannot consume images
- Click, move, or scroll a control by its snapshot number; refused if that control changed since
- A report of what changed in the front window's controls after every input action
- A `status` tool agents can call when tools fail, which works even while computer use is off
- Mouse clicks, movement, dragging, and scrolling
- Keyboard input and shortcuts
- App opening and foreground restoration
- Pointer position and short waits
- An optional screenshot returned with any input action (`screenshot: true`)
- One long-lived engine process, so each step takes milliseconds instead of a new process
- Per-agent `off`, `ask`, and `auto` modes
- Allow and Deny cards in agent chats, plus "Allow <app> this turn" for pointer actions
- A one-agent-at-a-time screen lease
- Mandatory built-in blocks for Paseo, terminals, code-running apps, System Settings, and password managers
- Global Stop and Resume controls
- Accessibility, Screen Recording, and engine health in the Computer panel, with buttons to open the matching System Settings pane, ask macOS for the Accessibility prompt, and check Screen Recording
- Audit logging that records typed character counts, never typed text

## Requirements

- macOS
- Paseo 0.13.0 or later
- **Accessibility** permission for Paseo
- **Screen & System Audio Recording** permission for Paseo

After granting Screen Recording, reopen Paseo. New agents receive the computer tools when they are created.

## Use

In an agent composer:

```text
/computer ask
/computer auto
/computer off
/computer status
```

The composer pill and the **Computer** workspace panel provide the same controls. Ask mode requires approval for every input action; read-only screenshots and accessibility snapshots do not ask again after access is enabled. For clicks, moves, drags, and scrolls, **Allow <app> this turn** also allows later pointer actions in that same app until the agent's turn ends; typing, key presses, opening apps, and drags between two apps always ask. Requests still waiting when the turn ends, the agent closes, or its mode changes are withdrawn.

## Security model

Computer use is off by default. Screenshots and accessibility snapshots are returned to the agent and therefore sent to that agent's model provider. Enabling desktop control weakens a provider's command or filesystem sandbox because the agent can operate signed-in desktop applications with the macOS user's permissions.

Ask mode helps prevent mistakes and prompt-injected actions, but it is not a security boundary against an already-hostile agent with arbitrary local command access. See [OVERVIEW.md](OVERVIEW.md) for the complete safety and data notes.

Screenshots capture the full main display by default. Turn on **Show agents only the front app** in the plugin settings to send only the front app's windows, at their real positions, with the rest of the screen black. Computerise refuses capture when a password manager is frontmost.

## Development

```bash
npm install
npm test
npm run typecheck
npm run test:live   # switches the front app to TextEdit and back, and clicks once into a scratch TextEdit document
```

The project has separate client, server, and shared runtime boundaries:

```text
index.client.tsx  -> client UI
index.server.ts   -> daemon policy and MCP server
shared/           -> validated contracts and blocklist data
```
