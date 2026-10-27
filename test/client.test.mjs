/**
 * Renderer-half smoke test: loads the real `lib/client.js` inside a `node:vm`
 * sandbox with stubbed browser globals, then drives `uiSession.sessionStatus`,
 * focus/visibility, and `api-session/error` through the transitions the plugin
 * watches.
 *
 * It verifies wiring and decisions (one banner per edge, badge counts every
 * session that needs attention, backgrounded window counts as "not watching",
 * failures clear on the next turn or on view), not how macOS renders a banner.
 *
 * Usage: node dev/client-harness.mjs
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8")

const failures = []
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures.push(name)
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`)
}

/** Build one isolated renderer world, so module state never leaks between scenarios. */
function createWorld({ preferences } = {}) {
  const notifications = []
  const badgeWrites = []
  const opened = []
  const windowListeners = new Map()
  const documentListeners = new Map()
  let focusCalls = 0
  let loader
  let errorHandler
  let focused = true
  let visible = true

  class FakeNotification {
    static permission = "granted"
    constructor(title, options) {
      this.title = title
      this.options = options
      this.onclick = undefined
      this.closed = false
      notifications.push(this)
    }
    static async requestPermission() {
      return "granted"
    }
    close() {
      this.closed = true
    }
  }

  const store = new Map()
  if (preferences !== undefined) {
    store.set("dsh-plugin-desktop-notify:preferences", JSON.stringify(preferences))
  }

  const fire = (table, names) => {
    for (const name of names) for (const handler of table.get(name) ?? []) handler()
  }

  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load(definition) {
          loader = definition
        },
      },
      focus() {
        focusCalls += 1
      },
      addEventListener(name, handler) {
        if (!windowListeners.has(name)) windowListeners.set(name, new Set())
        windowListeners.get(name).add(handler)
      },
      removeEventListener(name, handler) {
        windowListeners.get(name)?.delete(handler)
      },
    },
    navigator: {
      setAppBadge(value) {
        badgeWrites.push(value)
        return Promise.resolve()
      },
      clearAppBadge() {
        badgeWrites.push(0)
        return Promise.resolve()
      },
    },
    Notification: FakeNotification,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => {
        store.set(key, String(value))
      },
      removeItem: (key) => {
        store.delete(key)
      },
    },
    document: {
      documentElement: { lang: "zh-CN" },
      get visibilityState() {
        return visible ? "visible" : "hidden"
      },
      hasFocus: () => focused,
      addEventListener(name, handler) {
        if (!documentListeners.has(name)) documentListeners.set(name, new Set())
        documentListeners.get(name).add(handler)
      },
      removeEventListener(name, handler) {
        documentListeners.get(name)?.delete(handler)
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: "lib/client.js" })

  const statusListeners = new Set()
  const listListeners = new Set()
  let statuses = new Map()
  let summaries = {}

  const publish = () => {
    for (const listener of [...statusListeners]) listener()
    for (const listener of [...listListeners]) listener()
  }

  const ctx = {
    effect(register) {
      const dispose = register()
      return typeof dispose === "function" ? dispose : undefined
    },
    get(name) {
      if (name !== "remote") return undefined
      return {
        $on(event, handler) {
          if (event === "api-session/error") errorHandler = handler
          return () => {
            errorHandler = undefined
          }
        },
      }
    },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => statuses,
        subscribe(listener) {
          statusListeners.add(listener)
          return () => statusListeners.delete(listener)
        },
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({ phase: "ready", ids: Object.keys(summaries), byId: summaries }),
        subscribe(listener) {
          listListeners.add(listener)
          return () => listListeners.delete(listener)
        },
      },
    },
    uiWorkspace: {
      openSession: (sessionId) => opened.push(sessionId),
    },
  }

  const plugin = loader.factory(() => {
    throw new Error("the client half must not require anything")
  })
  plugin.apply(ctx)

  return {
    notifications,
    badgeWrites,
    opened,
    focusCalls: () => focusCalls,
    errorHandlerIsWired: () => typeof errorHandler === "function",
    emitError: (sessionId, message) => errorHandler?.(sessionId, message),
    setState(nextStatuses, nextSummaries) {
      statuses = nextStatuses
      if (nextSummaries !== undefined) summaries = nextSummaries
      publish()
    },
    setLanguage(lang) {
      sandbox.document.documentElement.lang = lang
    },
    setFocus(nextFocused, nextVisible = nextFocused) {
      const wasFocused = focused
      focused = nextFocused
      visible = nextVisible
      if (wasFocused !== nextFocused) fire(windowListeners, [nextFocused ? "focus" : "blur"])
      fire(documentListeners, ["visibilitychange"])
    },
    latestBadge: () => badgeWrites.at(-1),
  }
}

const user = (id, title, extra = {}) => ({ [id]: { id, title, origin: "user", ...extra } })
const viewed = (id, title) => user(id, title, { retainedBy: { mainView: 1 } })

console.log("client-half harness")

// 1. A background session finishes: one banner, Dock badge 1, click returns to it.
{
  const world = createWorld()
  world.setState(new Map([["s1", { running: true, completionUnread: false }]]), user("s1", "修桌面通知插件"))
  check("running session posts nothing", world.notifications.length === 0)
  check("startup clears any stale Dock badge exactly once", world.badgeWrites.length === 1 && world.latestBadge() === 0)

  world.setState(new Map([["s1", { running: false, completionUnread: true }]]))
  check("finished background session posts one banner", world.notifications.length === 1, `got ${world.notifications.length}`)
  check("banner carries the session title", world.notifications[0]?.options?.body?.includes("修桌面通知插件") === true)
  check("banner title reads like the product", world.notifications[0]?.title === "任务已完成", world.notifications[0]?.title)
  check(
    "banner sets no tag (Windows 11 drops tags longer than ~34 chars)",
    world.notifications[0]?.options?.tag === undefined && world.notifications[0]?.options?.silent === undefined,
    JSON.stringify(world.notifications[0]?.options),
  )
  check("completion body reports the turn duration", /用时/u.test(world.notifications[0]?.options?.body ?? ""), world.notifications[0]?.options?.body)
  check("Dock badge shows 1 unread", world.latestBadge() === 1, String(world.latestBadge()))

  world.setState(new Map([["s1", { running: false, completionUnread: true }]]))
  check("an unchanged status does not re-notify", world.notifications.length === 1)

  world.notifications[0].onclick()
  check("click opens the finished session", world.opened[0] === "s1", JSON.stringify(world.opened))
  check("click raises the window", world.focusCalls() === 1)
  check("click closes the banner", world.notifications[0].closed === true)

  world.setState(new Map([["s1", { running: false, completionUnread: false }]]))
  check("the badge outlives the harness unread flag until you look", world.latestBadge() === 1, String(world.latestBadge()))
  world.setState(new Map([["s1", { running: false, completionUnread: false }]]), viewed("s1", "修桌面通知插件"))
  check("opening the session clears the Dock badge", world.latestBadge() === 0, String(world.latestBadge()))
}

// 2. Backgrounded window still counts as "not watching" — the core Codex case.
{
  const world = createWorld()
  world.setState(new Map([["s1", { running: true }]]), viewed("s1", "被盯着跑的会话"))
  world.setFocus(false, false)
  world.setState(new Map([["s1", { running: false, completionUnread: false }]]))
  check("finished while the window is in the background posts a banner", world.notifications.length === 1, `got ${world.notifications.length}`)
  check("it also leaves the badge", world.latestBadge() === 1, String(world.latestBadge()))

  world.setFocus(true, true)
  check("coming back to the window clears the badge", world.latestBadge() === 0, String(world.latestBadge()))
  check("coming back does not add a banner", world.notifications.length === 1)
}

// 3. Watching it in the foreground is silent by default; notifyViewed opts in.
{
  const world = createWorld()
  world.setState(new Map([["s1", { running: true }]]), viewed("s1", "盯着的会话"))
  world.setState(new Map([["s1", { running: false }]]))
  check("finished while you watch it: no banner", world.notifications.length === 0)
  check("finished while you watch it: no badge", world.latestBadge() === 0, String(world.latestBadge()))

  const chatting = createWorld({ preferences: { notifyViewed: true } })
  chatting.setState(new Map([["s1", { running: true }]]), viewed("s1", "盯着的会话"))
  chatting.setState(new Map([["s1", { running: false }]]))
  check("notifyViewed:true posts the watching banner", chatting.notifications.length === 1)
  check("notifyViewed:true still leaves no badge", chatting.latestBadge() === 0, String(chatting.latestBadge()))
}

// 4. Every badge item is one session needing attention; subagents stay out.
{
  const world = createWorld()
  const summaries = { ...user("a", "会话 A"), ...user("b", "会话 B"), sub: { id: "sub", title: "子代理", origin: "subagent" } }
  world.setState(
    new Map([
      ["a", { completionUnread: true }],
      ["b", { completionUnread: true }],
      ["sub", { completionUnread: true }],
    ]),
    summaries,
  )
  check("two sessions needing attention give badge 2", world.latestBadge() === 2, String(world.latestBadge()))
  check("subagent gets no banner", world.notifications.every((one) => !one.options.body.includes("子代理")))
  world.setState(new Map([["a", { completionUnread: true }]]), { ...summaries })
  check("a session that disappears drops out of the badge", world.latestBadge() === 1, String(world.latestBadge()))
}

// 5. Pending approval: banner + badge on the edge only, cleared when handled.
{
  const world = createWorld()
  world.setState(new Map([["s2", { running: true }]]), user("s2", "部署网关"))
  world.setState(new Map([["s2", { running: true, pendingInteraction: { kind: "approval", toolName: "Bash" } }]]))
  check("pending approval posts one banner", world.notifications.length === 1, `got ${world.notifications.length}`)
  check("pending banner uses the approval title", world.notifications[0]?.title === "等待你的批准", world.notifications[0]?.title)
  check("pending banner names the tool", world.notifications[0]?.options?.body?.includes("Bash") === true && world.notifications[0]?.options?.body?.includes("等待你的批准") === true, world.notifications[0]?.options?.body)
  check("a waiting approval also badges the Dock", world.latestBadge() === 1, String(world.latestBadge()))
  world.setState(new Map([["s2", { running: true, pendingInteraction: { kind: "approval", toolName: "Bash" } }]]))
  check("the same approval does not re-notify or re-badge", world.notifications.length === 1 && world.latestBadge() === 1)
  world.setState(new Map([["s2", { running: true }]]))
  check("handled approval clears the badge", world.latestBadge() === 0, String(world.latestBadge()))
}

// 6. Failure: banner + badge, cleared by the next turn or by opening the session.
{
  const world = createWorld()
  world.setState(new Map([["s3", { running: true }]]), user("s3", "长任务"))
  check("error channel is wired", world.errorHandlerIsWired())

  world.emitError("s3", "stream error: connection reset")
  check("failure posts one banner", world.notifications.length === 1, `got ${world.notifications.length}`)
  check("failure banner uses the error title", world.notifications[0]?.title === "任务执行失败", world.notifications[0]?.title)
  check("failure banner carries the message", world.notifications[0]?.options?.body?.includes("connection reset") === true)
  check("failure badges the Dock", world.latestBadge() === 1, String(world.latestBadge()))

  world.setState(new Map([["s3", { running: false }]]))
  check("failure keeps its badge until dealt with", world.latestBadge() === 1, String(world.latestBadge()))

  world.setState(new Map([["s3", { running: true }]]))
  check("a new turn clears the failure badge", world.latestBadge() === 0, String(world.latestBadge()))

  world.emitError("s3", "boom")
  check("second failure notifies again", world.notifications.length === 2)
  world.setState(new Map([["s3", { running: false, completionUnread: true }]]), viewed("s3", "长任务"))
  check("opening the session clears both facts", world.latestBadge() === 0, String(world.latestBadge()))
  check("watching a session never notifies for it", world.notifications.length === 2, `got ${world.notifications.length}`)
}

// 7. Copy follows the UI language, not the OS.
{
  const world = createWorld()
  world.setLanguage("en-US")
  world.setState(new Map([["s1", { running: true }]]), user("s1", "Fix the notifier"))
  world.setState(new Map([["s1", { running: false }]]))
  check("english completion title follows <html lang>", world.notifications[0]?.title === "Task completed", world.notifications[0]?.title)
  check("english body names the session", world.notifications[0]?.options?.body?.includes("Fix the notifier") === true, world.notifications[0]?.options?.body)
  check("english body reports the duration", /completed in/iu.test(world.notifications[0]?.options?.body ?? ""), world.notifications[0]?.options?.body)
}

// 8. Preferences: mute banners, keep the badge; mute the badge alone.
{
  const muted = createWorld({ preferences: { notifications: false } })
  muted.setState(new Map([["s4", { completionUnread: true }]]), user("s4", "静音"))
  check("notifications:false suppresses banners", muted.notifications.length === 0)
  check("notifications:false keeps the badge", muted.latestBadge() === 1, String(muted.latestBadge()))

  const noBadge = createWorld({ preferences: { badge: false } })
  noBadge.setState(new Map([["s5", { completionUnread: true }]]), user("s5", "无徽标"))
  check("badge:false still notifies", noBadge.notifications.length === 1)
  check("badge:false never writes a number", noBadge.latestBadge() === 0, String(noBadge.latestBadge()))
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`)
  process.exitCode = 1
} else {
  console.log("\nall checks passed")
}
