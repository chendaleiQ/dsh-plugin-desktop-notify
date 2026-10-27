# dsh-plugin-desktop-notify

Desktop notifications and an app-icon badge for DSH: a finished turn, a pending approval or question, and a failure, with click-through back to that session.

## What it does

- **Turn finished** — including while the window is backgrounded or another app is in front
- **You are needed** — a tool approval, a question, or a plan waiting for confirmation
- **Turn failed** — the error is summarised in the body
- **Badge** — the app icon carries the number of sessions that need you, cleared once you have looked
- **Click a notification** — it switches to that session instead of only raising the app

Subagent sessions are skipped by default.

## Install

DSH desktop → **Plugins** → Install, then paste the package name:

```
dsh-plugin-desktop-notify
```

Press **⌘R** afterwards. The GitHub address
(`https://github.com/chendaleiQ/dsh-plugin-desktop-notify`) and an absolute local
directory work the same way.

## Preferences

Stored in localStorage under `dsh-plugin-desktop-notify.preferences`:

| Field | Default | Meaning |
| --- | --- | --- |
| `notifications` | `true` | Master switch |
| `notifyComplete` | `true` | Notify when a turn finishes |
| `notifyPending` | `true` | Notify for an approval / question / plan |
| `notifyError` | `true` | Notify when a turn fails |
| `notifyViewed` | `false` | Also notify for the session you are looking at |
| `badge` | `true` | Show the badge |
| `excludeSubagents` | `true` | Ignore subagent sessions |
| `titleComplete` / `titlePending` / `titleError` | empty | Custom titles; empty keeps the built-in copy |
| `maxBodyChars` | `140` | Body length limit |

## Language

The copy follows DSH's language setting (Settings → General → Language): Chinese
by default, English once the app is switched.

## Self-check

From the renderer console:

```js
__DSH_DESKTOP_NOTIFY__.capabilities()
__DSH_DESKTOP_NOTIFY__.state()
__DSH_DESKTOP_NOTIFY__.report()
```

## Known limits

- **Windows**: clicking a notification switches the session, but the window does
  not always come to the front — the AppUserModelID and a main-process focus
  channel are the desktop app's to provide
- **Attribution**: the notification centre shows DeepSeek Harness, because the
  banner is a renderer-side native notification
- **Host half** (`index.js`, an osascript fallback) is off by default; switch it on
  only when a renderer cannot post notifications

## Development

```bash
node test/client.test.mjs
node test/host.test.mjs
```

## License

MIT · https://github.com/chendaleiQ/dsh-plugin-desktop-notify
