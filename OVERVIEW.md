# Computerise

Computerise lets Paseo agents see and control the main display of the Mac running the Paseo daemon. It works across agent providers through ten MCP tools for screenshots, accessibility snapshots, clicking, moving, dragging, scrolling, typing, key presses, zooming, and opening apps.

Version 0.2.0 makes built-in safety blocks mandatory and migrates existing version-1 settings automatically.

Computer use is off for every agent by default. Choose **Ask before actions** to approve each input action in the agent chat, or **Automatic** to let that agent act without individual approvals. Read-only screenshots and accessibility snapshots do not ask again after computer use is enabled. One agent holds the screen at a time, and **Stop computer use** immediately cancels pending approvals and releases that lease.

## Setup

Computerise requires Paseo 0.13 on macOS. In **System Settings → Privacy & Security**, grant **Screen & System Audio Recording** and **Accessibility** to Paseo. Reopen Paseo after granting screen recording. No additional software is installed.

New agents receive the computer tools when they are created. Agents created before the plugin was enabled must be recreated. Use `/computer ask`, `/computer auto`, or the composer control to turn access on for an agent. Use `/computer off` to turn it off.

## Safety and data

- Screenshots and accessibility snapshots are returned to the agent and are therefore sent to that agent's model provider. The Computer panel also shows the latest screenshot in the connected Paseo app. The screenshot is held only in plugin memory and is not written to disk.
- Computer use weakens an agent provider's filesystem or command sandbox because an agent can operate signed-in desktop applications with your macOS user permissions.
- Ask mode helps prevent mistakes and actions caused by instructions embedded in pages, email, or documents. It is not a security boundary against a hostile agent that can already run arbitrary local commands.
- Paseo itself, terminals, code-running apps, System Settings, and password managers are always blocked. A screenshot or accessibility snapshot is refused when a password manager is frontmost. Other visible windows can still appear in a full-display screenshot; this version does not redact individual windows. The settings screen can add bundle IDs. Paseo cannot be unblocked, so an agent cannot press its own approval button through these tools.
- Approving from a phone is preferable when available because pressing Allow in the desktop app changes the foreground application. Computerise restores and rechecks the intended target before acting.
- Audit logs contain the time, agent, tool, target application, and outcome. Typing records only the character count, never the text. Logs rotate at 5 MB and keep one previous file.

## Limits

Computerise controls only the main display and takes over the real pointer and keyboard. It does not provide background window control. It supports macOS only. Some providers may not pass MCP image results to the model; agents can use the text accessibility snapshot instead. Computer controls are injected only when an agent is created, and an existing agent retains the tool server address it received at creation.
