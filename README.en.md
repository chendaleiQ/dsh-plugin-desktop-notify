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
| A turn finishes while you are not watching it | “Task completed” + “「name」Completed in 3m 12s” | +1 |
| A tool approval / question / plan review is waiting | “Approval needed” / “Your reply is needed” / “Plan review needed” | +1 |
| A turn fails | “Task failed” + the error summary | +1 |
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
- **Windows / Linux: untested, but expected to work.** Both surfaces are plain web
  APIs: Electron has supported the Badging API on Windows since v29 (taskbar overlay,
  see [the v29.1.5 Windows badge fix](https://releases.electronjs.org/release/v29.1.5)),
  and `Notification` maps to Windows toasts. The real caveat is that Windows toasts
  need an AppUserModelID plus a Start Menu shortcut, and the DSH main process never
  calls `app.setAppUserModelId`, so whether banners appear depends on the shortcut
  the installer writes.
- The only genuinely macOS-only code is the **optional host fallback**
  (`osascript` / `afplay` / `lsappinfo`), disabled by default.
- To check a platform: run `capabilities()` (it reports `platform`) and then
  `simulateComplete()`, and open an issue with the result.

### Banner click does nothing?

Read `__DSH_DESKTOP_NOTIFY__.state().lastClick`:

- `null` → the click never reached the renderer. Rare on macOS, **common on Windows**:
  WinRT toast activation needs a registered COM activator
  ([electron/electron#24524](https://github.com/electron/electron/issues/24524)), and without
  one the click may simply dismiss the toast. A plugin cannot fix that layer.
- `opened.ok: false` → the click arrived but the session switch failed; `opened.attempts`
  says why (`uiWorkspace` unreachable, `retain` failed, …).
- `opened.ok: true` but the view did not change → the window was hidden; the click only
  activates the app, so bring it forward from the Dock/taskbar.

The click path can be exercised directly with `__DSH_DESKTOP_NOTIFY__.openSession("<session id>")`.

### Windows: badge appears, no banner

**Fixed in v0.4.4**: older builds passed a long `tag`
(`dsh-plugin-desktop-notify:complete:<sessionId>`), and Windows 11 silently drops web
notifications whose tag is longer than ~34 characters
([electron/electron#40433](https://github.com/electron/electron/issues/40433)). The
plugin no longer sets `tag` / `silent`; dedupe relies on status edges, which is why a
bare `new Notification("t",{body:"b"})` showed up while the plugin's banner did not.

If it still fails after upgrading, use the checks below:


The badge is a taskbar overlay and needs no AppUserModelID. **Windows toasts do need an
AppUserModelID plus a Start Menu shortcut**, and the DSH main process never calls
`app.setAppUserModelId` (checked `lib/main.js`), so Windows can drop the toast silently —
it is not the plugin's logic. Confirm with:

```js
new Notification("test", { body: "windows toast check" })  // nothing here means app-level
__DSH_DESKTOP_NOTIFY__.state().lastNotify                   // the last delivery attempt
```

Two ways out: DSH sets `app.setAppUserModelId` upstream (then the current code shows toasts
with click-through), or the host half falls back to a PowerShell toast (visible, but
attributed to Windows PowerShell and without click-through).

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
__DSH_DESKTOP_NOTIFY__.state().lastClick    // what the last banner click did
__DSH_DESKTOP_NOTIFY__.openSession("<session id>")  // run the click path manually
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
  // empty = built-in copy, following the UI language (zh/en)
  titleComplete: "",
  titlePending: "",
  titleError: "",
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

- macOS is verified; Windows / Linux are untested (see Requirements).
- “Stuck” covers waiting-for-approval / question / plan review / failure; a
  “still running but silent for N minutes” watchdog would need a host timer.
- Badge facts live in host memory and reset when the app restarts (harness semantics).
- Conflicts with `@caohaoyangcn/dsh-dock-badge` (badge-only, with a settings page):
  install only one, they fight over the same Dock badge.

## License

MIT — use it however you like.
