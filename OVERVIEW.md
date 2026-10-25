# Computerise

Computerise lets Paseo agents see and control the main display of the Mac running the Paseo daemon. It works across agent providers through twelve MCP tools for screenshots, accessibility snapshots, pointer position, clicking, moving, dragging, scrolling, typing, key presses, zooming, opening apps, and short waits. Any input action can also return a screenshot taken just after it.

Version 0.3.1 fixes the review findings in 0.3.0: the screenshot an action returns passes every safety check, typing stops if another app comes to the front, Stop interrupts the running step, approvals end with the turn, and front-app-only screenshots use a capture method that no longer blocks. Version 0.3.0 runs every macOS step through one long-lived engine process, adds the pointer position and wait tools, an optional front-app-only screenshot, per-app approval for pointer actions, and permission health in the Computer panel. Existing settings keep working; new settings start at their previous behavior.

Computer use is off for every agent by default. Choose **Ask before actions** to approve each input action in the agent chat, or **Automatic** to let that agent act without individual approvals. In ask mode, **Allow <app> this turn** on a click, move, drag, or scroll also allows later pointer actions in that app until the agent's turn ends, the agent closes, its mode changes, or computer use is stopped. Typing, key presses, opening apps, and drags between two apps always ask. A request still waiting when the turn ends, the agent closes, or its mode changes is withdrawn and does nothing. Read-only screenshots and accessibility snapshots do not ask again after computer use is enabled. One agent holds the screen at a time, and **Stop computer use** immediately cancels pending approvals, releases that lease, and interrupts the macOS step that is running, such as a long piece of typing.

## Setup

Computerise requires Paseo 0.13 on macOS. In **System Settings → Privacy & Security**, grant **Screen & System Audio Recording** and **Accessibility** to Paseo. Reopen Paseo after granting screen recording. No additional software is installed.

New agents receive the computer tools when they are created. Agents created before the plugin was enabled must be recreated. Use `/computer ask`, `/computer auto`, or the composer control to turn access on for an agent. Use `/computer off` to turn it off.

## Safety and data

- Screenshots and accessibility snapshots are returned to the agent and are therefore sent to that agent's model provider. The Computer panel also shows the latest screenshot in the connected Paseo app. The screenshot is held only in plugin memory and is not written to disk; the panel downloads it only when a new one is taken.
- With **Show agents only the front app** on, screenshots and zooms contain only the front app's windows at their real positions; everything else, including the menu bar and Dock, is black. If macOS returns none of the app's windows, the capture fails rather than falling back to the full display.
- Computer use weakens an agent provider's filesystem or command sandbox because an agent can operate signed-in desktop applications with your macOS user permissions.
- Ask mode helps prevent mistakes and actions caused by instructions embedded in pages, email, or documents. It is not a security boundary against a hostile agent that can already run arbitrary local commands.
- Paseo itself, terminals, code-running apps, System Settings, and password managers are always blocked. A screenshot or accessibility snapshot is refused when a password manager is frontmost. With the default full-display setting, other visible windows can appear in a screenshot. The settings screen can add bundle IDs. Paseo cannot be unblocked, so an agent cannot press its own approval button through these tools.
- Approving from a phone is preferable when available because pressing Allow in the desktop app changes the foreground application. Computerise restores and rechecks the intended target before acting.
- Keys go to the app in front, so typing and key presses check that app before the first key and every 20 characters; if another app has come forward, they stop and report how many characters were typed.
- Audit logs contain the time, agent, tool, target application, and outcome. Typing records only the character count, never the text. Logs rotate at 5 MB and keep one previous file.

## Limits

Computerise controls only the main display and takes over the real pointer and keyboard. Electron apps such as Slack expose little more than their window frame to the text accessibility snapshot, so text-only models see little of them. It does not provide background window control. It supports macOS only. Some providers may not pass MCP image results to the model; agents can use the text accessibility snapshot instead. Computer controls are injected only when an agent is created, and an existing agent retains the tool server address it received at creation.
