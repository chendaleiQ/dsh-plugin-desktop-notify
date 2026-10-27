# dsh-plugin-desktop-notify

Codex-style **macOS notifications and a Dock unread badge** for the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) desktop app.

- A native banner, attributed to **DeepSeek Harness itself**, when a turn finishes
  **even while the window is in the background**, when a tool approval / question /
  plan review is waiting, or when a turn fails.
- **Click the banner to jump back to that session** and raise the window.
- The Dock icon keeps a number for every session that needs you until you actually
  look at it.

[中文](README.md) · MIT

## What it does

| Event | Banner | Dock badge |
|---|---|---|
| A turn finishes while you are not watching it | “DSH 任务完成” + session title | +1 |
| A tool approval / question / plan review is waiting | “DSH 需要你确认” | +1 |
| A turn fails | “DSH 任务出错” + error summary | +1 |
| You open (and look at) that session | — | cleared |

Rules:

- **A notification always implies a badge**: both read the same attention facts.
- **“Watching” means** the session is in the main view **and** the window is focused
  **and** visible. The harness’s own `completionUnread` only covers the first case;
  a backgrounded window is invisible to the host, so the plugin adds the
  focus/visibility half itself with `document.hasFocus()` / `visibilityState`.
- **The badge is sticky** until you actually look at the session; the harness
  clearing `completionUnread` does not silently drop it.
- A failed turn posts the error banner only, never an extra “completed” one.
- Sessions of subagents / Agent Teams members are ignored.

## Requirements

- Tested on **DSH Desktop 0.2.1-rc.3** (Electron **44.7.0**) on **macOS**.
- The desktop shell must register `dsh-app://` as a secure context (current builds do),
  otherwise `navigator.setAppBadge` and `Notification` are unavailable
  (`capabilities()` in DevTools reports `badge: false`).
- System Settings → Notifications → **DeepSeek Harness** must be allowed, otherwise
  you get the badge without banners.
- Windows / Linux: not implemented.

## Install

Inside the DSH desktop app: **Plugins → Install**, then paste the repository address:

```
https://github.com/chendaleiQ/dsh-plugin-desktop-notify
```

Press **⌘R** afterwards so the renderer reloads the bundle (restart the app if it
says `restart-required`).

A local checkout works too: clone it and point the install dialog at the **directory**.
For development, symlink it into the profile:

```bash
git clone https://github.com/chendaleiQ/dsh-plugin-desktop-notify.git
cd dsh-plugin-desktop-notify
ln -s "$PWD" ~/.dsh/profiles/desktop/node_modules/dsh-plugin-desktop-notify
# then add "dsh-plugin-desktop-notify" to dsh.profile.bundles in
# ~/.dsh/profiles/desktop/package.json
```

## Self-check

Open DevTools (`⌘⌥I`) in the app window:

```js
__DSH_DESKTOP_NOTIFY__.capabilities()       // {notification:"granted", badge:true, ...}
__DSH_DESKTOP_NOTIFY__.state()              // live attention + badge number
__DSH_DESKTOP_NOTIFY__.simulateComplete()   // fire a banner and set the badge to 1
__DSH_DESKTOP_NOTIFY__.reset()              // undo the simulation
```

## Preferences

No settings UI; preferences live in the renderer’s `localStorage`
(desktop and web profiles are independent), applied after ⌘R:

```js
localStorage.setItem("dsh-plugin-desktop-notify:preferences", JSON.stringify({
  notifications: true,    // banners master switch
  notifyComplete: true,
  notifyPending: true,    // approvals / questions / plan reviews
  notifyError: true,
  notifyViewed: false,    // true = also banner the session you are watching
  badge: true,            // Dock badge master switch
  excludeSubagents: true,
  titleComplete: "DSH 任务完成",
  titlePending: "DSH 需要你确认",
  titleError: "DSH 任务出错",
  maxBodyChars: 140
}))
```

## How it works

Both surfaces only exist in the desktop **renderer**, not in the Host process:

| Capability | API | Lands at |
|---|---|---|
| Native banner + click callback | `new Notification(...)` / `onclick` | Electron → macOS Notification Center, attributed to DeepSeek Harness |
| Dock badge | `navigator.setAppBadge(n)` / `clearAppBadge()` | Chromium → Electron `BadgeManager` → `NSDockTile.badgeLabel` |

Facts come from the harness’s own `uiSession.sessionStatus`
(`completionUnread`, `pendingInteraction`, the same data the sidebar dots read) plus
`api-session/error` for failures, so “read” means exactly what the official UI means.

The Host half (`index.js`) is an **osascript fallback, disabled by default**: flip
`enabled` in `cordis.patch.yml` if a renderer has no `Notification` (enabling both
double-notifies).

## Development

Zero dependencies, hand-written ES modules, no build step.

```bash
node test/client.test.mjs                     # renderer half: node:vm + stubbed globals
node test/host.test.mjs /tmp/host-test.log    # host fallback
npm test
```

## Limitations

- macOS only.
- “Stuck” covers waiting-for-approval / question / plan review / failure; a
  “still running but silent for N minutes” watchdog would need a host timer.
- Badge facts live in host memory and reset when the app restarts (harness semantics).
- Conflicts with `@caohaoyangcn/dsh-dock-badge` (badge-only, with a settings page):
  install only one, they fight over the same Dock badge.

## License

MIT — use it however you like.
