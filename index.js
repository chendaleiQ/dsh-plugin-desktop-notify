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
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

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
  notifyOnTurnEndKinds: ["completed", "aborted", "error", "blocked", "max-tokens"],
  maxBodyChars: 140,
  logPath: "~/.dsh/desktop-notify.log",
  maxTrackedSessions: 64,
  /** Log the decision without spawning osascript/afplay; the tests use it. */
  dryRun: false,
  /** Local interface other tools post notifications to (see README). */
  api: true,
  /** Where the endpoint URL is written for those tools. */
  endpointPath: "~/.dsh/desktop-notify.endpoint",
  /** Where the sessions this plugin pinned are remembered across window lives. */
  pinsPath: "~/.dsh/desktop-notify-pins.json",
  /** Longest accepted request body. */
  apiBodyLimit: 8192,
  /** How many unread requests the interface keeps. */
  apiQueueLimit: 50,
}

/** Turn-end bodies for the kinds that carry no model text. */
const TURN_END_BODIES = {
  error: (reason) => `本轮出错：${reason?.error?.message ?? "未知错误"}`,
  aborted: () => "本轮已中止",
  blocked: () => "本轮被拦截",
  "max-tokens": () => "输出达到上限，本轮结束",
}

/** The URL path tools post to, and the paths the renderer drains and asks. */
const API_REQUEST_PATH = "/desktop-notify/request"
const API_PENDING_PATH = "/desktop-notify/pending"
const API_TURN_PATH = "/desktop-notify/turn"
const API_PINS_PATH = "/desktop-notify/pins"

/** Read one JSON request body, bounded by `limit` bytes. */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("body too large"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}

/** Write one JSON answer with the headers a local tool needs. */
function answer(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  })
  response.end(body)
}

/**
 * Mount the local notification interface other tools (a watch script, a
 * browser agent, a cron job) post to.
 *
 * Three routes on the Host's own web server: POST a request, the renderer
 * drains the queue over the app protocol, and the renderer asks how the turn
 * that just ended actually ended so it can word the banner. `ctx.inject` waits
 * for the `webServer` service instead of reading it once: the server finishes
 * binding after this plugin applies, and a single `ctx.get` loses that race
 * almost every launch.
 *
 * Requests are fenced: the external route demands the token the endpoint file
 * carries (loopback plus token, no login), while the renderer routes rely on
 * the Host's own `connection` admission, so a cross-site page cannot post
 * banners or drain the queue.
 */
function mountInterface(ctx, config, state) {
  if (!config.api) return

  const mount = (hostCtx) => {
    const server = (() => {
      try {
        const injected = hostCtx.webServer
        if (injected !== undefined) return injected
      } catch {
        /* a context without the service in `inject` throws on property access */
      }
      return hostCtx.get?.("webServer")
    })()
    if (server === undefined || typeof server.register !== "function") {
      void noteToLog(config.logPath, "interface: the Host has no webServer service; the interface is unavailable")
      return
    }

    const token = randomBytes(16).toString("hex")
    const queue = []

    const urlOf = (request) => {
      try {
        return new URL(String(request?.url ?? "/"), "http://127.0.0.1")
      } catch {
        return undefined
      }
    }
    const tokenOf = (request) => {
      const fromQuery = urlOf(request)?.searchParams.get("token")
      if (typeof fromQuery === "string" && fromQuery !== "") return fromQuery
      const header = request?.headers?.["x-dsh-notify-token"]
      return typeof header === "string" ? header : undefined
    }
    const connectionOf = () => {
      try {
        return hostCtx.get?.("connection")
      } catch {
        return undefined
      }
    }

    /**
     * Answer a caller that may not use this interface; false when it may.
     * `external` routes demand the endpoint token; renderer routes accept the
     * Host's own admission (its login cookie) or the token.
     */
    const rejected = (request, response, external) => {
      if (tokenOf(request) === token) return false
      if (external) {
        answer(response, 401, { ok: false, error: "a token is required; post to the URL in ~/.dsh/desktop-notify.endpoint" })
        return true
      }
      const connection = connectionOf()
      let status
      try {
        status = typeof connection?.requestRejection === "function" ? connection.requestRejection(request) : undefined
      } catch {
        status = undefined
      }
      if (status === undefined) return false
      answer(response, status, { ok: false, error: "unauthorized" })
      return true
    }

    const post = async (request, response) => {
      if (rejected(request, response, true)) return
      if (request.method === "OPTIONS") {
        answer(response, 204, {})
        return
      }
      if (request.method !== "POST") {
        answer(response, 405, { ok: false, error: "use POST" })
        return
      }
      let payload
      try {
        payload = await readBody(request, Math.max(1024, config.apiBodyLimit))
      } catch (error) {
        answer(response, 400, { ok: false, error: String(error?.message ?? error) })
        return
      }
      const title = typeof payload?.title === "string" ? payload.title.trim() : ""
      const body = typeof payload?.body === "string" ? payload.body.trim() : ""
      if (title === "" && body === "") {
        answer(response, 400, { ok: false, error: "title or body is required" })
        return
      }
      queue.push({
        at: new Date().toISOString(),
        title: title === "" ? "DeepSeek Harness" : title,
        body: body.slice(0, 400),
        ...typeof payload?.sessionId === "string" && payload.sessionId !== "" ? { sessionId: payload.sessionId } : {},
      })
      while (queue.length > Math.max(1, config.apiQueueLimit)) queue.shift()
      answer(response, 202, { ok: true, queued: queue.length })
    }

    const pending = (request, response) => {
      if (rejected(request, response, false)) return
      if (request.method !== "GET") {
        answer(response, 405, { ok: false, error: "use GET" })
        return
      }
      const items = queue.splice(0, queue.length)
      answer(response, 200, items)
    }

    const turn = (request, response) => {
      if (rejected(request, response, false)) return
      if (request.method !== "GET") {
        answer(response, 405, { ok: false, error: "use GET" })
        return
      }
      const sessionId = urlOf(request)?.searchParams.get("sessionId") ?? ""
      const entry = state.lastTurnEnds.get(sessionId)
      answer(response, 200, entry === undefined ? {} : { kind: entry.kind, at: entry.at })
    }

    /**
     * Remember which sessions this plugin pinned. The renderer's origin (and so
     * its localStorage) changes with every launch, while the sidebar pins live
     * on the Host; this file is what lets a restart release the pins it owns
     * instead of mistaking them for the user's own.
     */
    const pins = (request, response) => {
      if (rejected(request, response, false)) return
      if (request.method === "GET") {
        answer(response, 200, { ids: [...state.pinnedByPlugin] })
        return
      }
      if (request.method !== "POST") {
        answer(response, 405, { ok: false, error: "use GET or POST" })
        return
      }
      void readBody(request, Math.max(1024, config.apiBodyLimit))
        .then((payload) => {
          const ids = Array.isArray(payload?.ids) ? payload.ids.filter((id) => typeof id === "string" && id !== "") : []
          state.pinnedByPlugin = new Set(ids.slice(0, Math.max(1, config.maxTrackedSessions)))
          const path = expandHome(config.pinsPath)
          if (path !== "") {
            void mkdir(dirname(path), { recursive: true })
              .then(() => writeFile(path, `${JSON.stringify({ ids: [...state.pinnedByPlugin] })}\n`, "utf8"))
              .catch(() => {})
          }
          answer(response, 200, { ok: true, tracked: state.pinnedByPlugin.size })
        })
        .catch((error) => answer(response, 400, { ok: false, error: String(error?.message ?? error) }))
    }

    let disposers
    try {
      disposers = [
        server.register({ kind: "exact", path: API_REQUEST_PATH, handler: (request, response) => {
          void post(request, response).catch(() => answer(response, 500, { ok: false }))
        } }),
        server.register({ kind: "exact", path: API_PENDING_PATH, handler: (request, response) => {
          try {
            pending(request, response)
          } catch {
            answer(response, 500, [])
          }
        } }),
        server.register({ kind: "exact", path: API_TURN_PATH, handler: (request, response) => {
          try {
            turn(request, response)
          } catch {
            answer(response, 500, {})
          }
        } }),
        server.register({ kind: "exact", path: API_PINS_PATH, handler: (request, response) => {
          try {
            pins(request, response)
          } catch {
            answer(response, 500, { ok: false })
          }
        } }),
      ]
    } catch (error) {
      void noteToLog(config.logPath, `interface: cannot register routes: ${String(error)}`)
      return
    }

    // Hand the caller an address to post to; the port is whatever the Host
    // took, and the token keeps every other local page out.
    const endpointPath = expandHome(config.endpointPath)
    const origin = (() => {
      try {
        return typeof server.getOrigin === "function" ? server.getOrigin() : undefined
      } catch {
        return undefined
      }
    })() ?? (typeof server.port === "number" ? `${typeof server.protocol === "string" ? server.protocol : "http:"}//127.0.0.1:${server.port}` : undefined)
    if (endpointPath !== "" && origin !== undefined) {
      void mkdir(dirname(endpointPath), { recursive: true })
        .then(() => writeFile(endpointPath, `${origin}${API_REQUEST_PATH}?token=${token}\n`, "utf8"))
        .then(() => noteToLog(config.logPath, `interface: ${origin}${API_REQUEST_PATH}`))
        .catch((error) => noteToLog(config.logPath, `interface: cannot write the endpoint file: ${String(error)}`))
    } else {
      void noteToLog(config.logPath, "interface: routes registered but the address is unknown")
    }

    hostCtx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* the route table is being torn down anyway */
        }
      }
      if (endpointPath !== "") void rm(endpointPath, { force: true }).catch(() => {})
    }, "desktop-notify: local interface")
  }

  // A Host without `inject` (older composition) still gets one best-effort try.
  if (typeof ctx.inject !== "function") {
    mount(ctx)
    return
  }
  ctx.inject(["webServer"], (hostCtx) => {
    mount(hostCtx)
  })
}

/** Append one best-effort line to the log from outside the session machinery. */
async function noteToLog(logPathConfig, line) {
  try {
    const path = expandHome(logPathConfig)
    if (path === "") return
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${new Date().toISOString()} ${line}\n`, "utf8")
  } catch {
    /* logging is best effort */
  }
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
  /** The newest turn-end kind per session, read by the renderer over the local interface. */
  const state = { lastTurnEnds: new Map(), pinnedByPlugin: new Set() }
  // Seeded synchronously: the renderer asks for it as soon as it applies.
  try {
    const pinsPath = expandHome(config.pinsPath)
    if (pinsPath !== "") {
      const remembered = JSON.parse(readFileSync(pinsPath, "utf8"))
      if (Array.isArray(remembered?.ids)) {
        for (const id of remembered.ids) if (typeof id === "string" && id !== "") state.pinnedByPlugin.add(id)
      }
    }
  } catch {
    /* no remembered pins yet */
  }
  mountInterface(ctx, config, state)

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

  /**
   * Keep the real reason of the last turn. The renderer's session status only
   * carries `running` / `completionUnread`, so without this every ending —
   * blocked, max-tokens, aborted — would be announced as "completed".
   */
  function rememberTurnEnd(session, event) {
    if (event?.type !== "turn/end") return
    const sessionId = session?.id
    if (typeof sessionId !== "string" || sessionId === "") return
    state.lastTurnEnds.delete(sessionId)
    state.lastTurnEnds.set(sessionId, {
      kind: event?.data?.reason?.kind ?? "completed",
      at: new Date().toISOString(),
    })
    while (state.lastTurnEnds.size > Math.max(1, config.maxTrackedSessions)) {
      const oldest = state.lastTurnEnds.keys().next()
      if (oldest.done === true) break
      state.lastTurnEnds.delete(oldest.value)
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

  /**
   * One dispatch per committed event; work stays off the append path. The
   * turn-end record is kept even with the osascript fallback switched off,
   * because the renderer asks for it to word its own banner.
   */
  ctx.on("session/event", (session, event) => {
    try {
      rememberTurnEnd(session, event)
    } catch (error) {
      void writeLog(`error session=${session?.id ?? "-"} ${String(error)}`)
    }
    if (!config.enabled) return
    try {
      handleEvent(session, event)
    } catch (error) {
      void writeLog(`error session=${session?.id ?? "-"} ${String(error)}`)
    }
  })

  /** A disposed session must not keep its remembered text or turn kind alive. */
  ctx.on("session/disposed", (session) => {
    const sessionId = session?.id
    if (typeof sessionId !== "string") return
    pendingText.delete(sessionId)
    state.lastTurnEnds.delete(sessionId)
  })

  if (!config.enabled) return
  void writeLog(`plugin started pid=${process.pid} platform=${process.platform} onlyWhenUnfocused=${config.onlyWhenUnfocused}`)
}
