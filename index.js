/**
 * dsh-plugin-desktop-notify
 *
 * Host plugin for a DeepSeek Harness profile: post a macOS notification when a
 * turn ends (completed / error / blocked / max-tokens) or when a tool approval
 * is waiting for the user. Banners go through `osascript`, so they are
 * attributed to the AppleScript host app rather than to Harness itself; the
 * optional `sound` keeps an audible cue even when that app's notification
 * permission is off.
 *
 * The plugin observes the session log through the same `session/event` seam the
 * persistence plugins use, so it never participates in a decision: it only
 * reads committed events, and every side effect is deferred off the synchronous
 * append path.
 */

import { execFile, spawn } from "node:child_process"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname } from "node:path"

/** Read the notification in argv order, so no AppleScript string escaping is needed. */
const APPLESCRIPT = [
  "on run argv",
  "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
  "end run",
].join("\n")

const DEFAULTS = {
  enabled: true,
  onTurnEnd: true,
  onApproval: true,
  onlyWhenUnfocused: true,
  frontmostAppNames: ["DeepSeek Harness"],
  sound: true,
  soundFile: "/System/Library/Sounds/Glass.aiff",
  titleTurnEnd: "DSH 任务完成",
  titleApproval: "DSH 需要你确认",
  notifyOnTurnEndKinds: ["completed", "error", "blocked", "max-tokens"],
  maxBodyChars: 140,
  logPath: "~/.dsh/desktop-notify.log",
  maxTrackedSessions: 64,
  /** Log the decision without spawning osascript/afplay; the tests use it. */
  dryRun: false,
}

/** Turn-end bodies for the kinds that carry no model text. */
const TURN_END_BODIES = {
  error: (reason) => `本轮出错：${reason?.error?.message ?? "未知错误"}`,
  aborted: () => "本轮已中止",
  blocked: () => "本轮被拦截",
  "max-tokens": () => "输出达到上限，本轮结束",
}

/** Merge the row's config over the defaults, keeping field types honest. */
function resolveConfig(raw) {
  const config = { ...DEFAULTS }
  if (raw === null || typeof raw !== "object") return config
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key]
    if (value === undefined) continue
    if (Array.isArray(fallback)) {
      if (!Array.isArray(value)) continue
    } else if (typeof value !== typeof fallback) continue
    config[key] = value
  }
  return config
}

/** Expand one leading `~` so the log path can be written in config. */
function expandHome(path) {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path
}

/** Collapse whitespace and cut to the configured body budget. */
function bodyText(text, maxChars) {
  const collapsed = String(text).replace(/\s+/gu, " ").trim()
  if (collapsed.length <= maxChars) return collapsed
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`
}

/** The first visible line of an assistant message's text blocks. */
function firstTextLine(message) {
  if (message === null || typeof message !== "object" || !Array.isArray(message.content)) return ""
  for (const block of message.content) {
    if (block === null || typeof block !== "object" || block.type !== "text") continue
    const text = typeof block.text === "string" ? block.text.trim() : ""
    if (text !== "") return text
  }
  return ""
}

/** Direct children of a session belong to subagents; they get no banner. */
function isNotifiableSession(session) {
  const header = session?.header
  if (header === null || typeof header !== "object") return false
  if (header.origin === "subagent") return false
  return header.parentSession === undefined
}

/** The workspace folder is the closest thing to a session name without a title lookup. */
function subtitleOf(session) {
  const cwd = session?.header?.cwd
  if (typeof cwd !== "string" || cwd === "") return "DSH"
  return basename(cwd) || "DSH"
}

/** Parse the app name out of `lsappinfo info -only name`. */
function parseFrontmostApp(stdout) {
  const match = /^"([^"]+)"/u.exec(String(stdout).trim())
  return match === null ? undefined : match[1]
}

/** The foreground application's display name, or undefined when it cannot be read. */
function frontmostApp() {
  return new Promise((resolve) => {
    execFile("/usr/bin/lsappinfo", ["front"], { timeout: 2000 }, (frontError, frontOut) => {
      if (frontError !== null) return resolve(undefined)
      const asn = String(frontOut).trim()
      if (asn === "") return resolve(undefined)
      execFile("/usr/bin/lsappinfo", ["info", "-only", "name", asn], { timeout: 2000 }, (infoError, infoOut) => {
        resolve(infoError !== null ? undefined : parseFrontmostApp(infoOut))
      })
    })
  })
}

/** Start a detached child: the Host never waits on banners or audio. */
function runDetached(command, args) {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
  } catch {
    /* notification support is best effort; a missing helper must not break a turn */
  }
}

/**
 * @param {object} ctx - the plugin context; the row is mounted on the profile root.
 * @param {object} rawConfig - the row's `config` from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const logPath = expandHome(config.logPath)
  const pendingText = new Map()

  /** Append one diagnostic line; the log is the only durable evidence of a fired banner. */
  async function writeLog(line) {
    if (config.logPath === "") return
    try {
      await mkdir(dirname(logPath), { recursive: true })
      await appendFile(logPath, `${new Date().toISOString()} ${line}\n`, "utf8")
    } catch {
      /* a log that cannot be written must not break notification delivery */
    }
  }

  /** Remember the newest assistant text per session, trimmed to a small cache. */
  function remember(sessionId, text) {
    if (text === "") return
    pendingText.delete(sessionId)
    pendingText.set(sessionId, text)
    while (pendingText.size > config.maxTrackedSessions) {
      const oldest = pendingText.keys().next()
      if (oldest.done === true) break
      pendingText.delete(oldest.value)
    }
  }

  /** Deliver one banner and the optional sound, honoring the focus rule. */
  async function deliver(kind, session, body) {
    try {
      const app = await frontmostApp()
      const sessionId = session?.id ?? "-"
      if (config.onlyWhenUnfocused && app !== undefined && config.frontmostAppNames.includes(app)) {
        await writeLog(`skip kind=${kind} reason=focused app=${app} session=${sessionId} body=${body}`)
        return
      }
      const title = kind === "approval" ? config.titleApproval : config.titleTurnEnd
      const subtitle = subtitleOf(session)
      if (process.platform === "darwin" && !config.dryRun) {
        runDetached("/usr/bin/osascript", ["-e", APPLESCRIPT, body, title, subtitle])
        if (config.sound && config.soundFile !== "") runDetached("/usr/bin/afplay", [config.soundFile])
      }
      await writeLog(`notify kind=${kind} app=${app ?? "-"} session=${sessionId} title=${title} subtitle=${subtitle} body=${body}`)
    } catch (error) {
      await writeLog(`error kind=${kind} ${String(error)}`)
    }
  }

  /** Decide what, if anything, one committed session event deserves. */
  function handleEvent(session, event) {
    const type = event?.type
    const data = event?.data
    if (!isNotifiableSession(session)) return
    const sessionId = session.id

    if (type === "assistant/message") {
      if (data?.interrupted === true) return
      remember(sessionId, firstTextLine(data?.message))
      return
    }

    if (type === "turn/end") {
      const kind = data?.reason?.kind ?? "completed"
      const remembered = pendingText.get(sessionId)
      pendingText.delete(sessionId)
      if (!config.onTurnEnd) return
      if (!config.notifyOnTurnEndKinds.includes(kind)) return
      const body = kind === "completed"
        ? bodyText(remembered ?? "本轮已完成", config.maxBodyChars)
        : bodyText(TURN_END_BODIES[kind]?.(data?.reason) ?? `本轮结束（${kind}）`, config.maxBodyChars)
      void deliver(`turn-end:${kind}`, session, body)
      return
    }

    if (type === "approval/asked") {
      if (!config.onApproval) return
      const toolName = typeof data?.toolName === "string" && data.toolName !== "" ? data.toolName : "未知工具"
      const reason = typeof data?.reason === "string" && data.reason !== "" ? `：${data.reason}` : ""
      void deliver("approval", session, bodyText(`工具 ${toolName} 等待你批准${reason}`, config.maxBodyChars))
    }
  }

  /** One dispatch per committed event; work stays off the append path. */
  ctx.on("session/event", (session, event) => {
    try {
      handleEvent(session, event)
    } catch (error) {
      void writeLog(`error session=${session?.id ?? "-"} ${String(error)}`)
    }
  })

  /** A disposed session must not keep its remembered text alive. */
  ctx.on("session/disposed", (session) => {
    const sessionId = session?.id
    if (typeof sessionId === "string") pendingText.delete(sessionId)
  })

  void writeLog(`plugin started pid=${process.pid} platform=${process.platform} onlyWhenUnfocused=${config.onlyWhenUnfocused}`)
}
