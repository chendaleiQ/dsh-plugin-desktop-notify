/**
 * dsh-plugin-desktop-notify — renderer half.
 *
 * Mirrors what the Codex desktop app does for "something needs you":
 *
 *  - a native macOS banner for a finished turn, a pending approval / question /
 *    plan review, or a turn that failed;
 *  - a Dock badge whose number is the count of sessions currently needing you,
 *    i.e. every banner also leaves a persistent red dot until you open that
 *    session (the user's rule: a notification always implies the badge);
 *  - clicking the banner opens the session and raises the window.
 *
 * Both surfaces run in the renderer: `new Notification(...)` is forwarded by
 * Electron to the macOS notification centre **as DeepSeek Harness**, and
 * `navigator.setAppBadge()` reaches Electron's BadgeManager and ends up at
 * `NSDockTile.badgeLabel`. The host process cannot touch either.
 *
 * Facts, not bookkeeping: the completion and waiting facts come from the
 * harness's own `uiSession.sessionStatus` (the same ones the sidebar dots read),
 * so "read" means "opened that session in the main view", exactly like the
 * official UI. Failures are event-sourced from `api-session/error`.
 *
 * Diagnostics: `window.__DSH_DESKTOP_NOTIFY__` in DevTools (⌘⌥I) reports the
 * capabilities and the live attention state, and can drive each surface by
 * hand.
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-desktop-notify",
  factory: (require) => {
    const NS = "dsh-plugin-desktop-notify"
    const PREFERENCES_KEY = `${NS}:preferences`

    /** Defaults; override per field with the localStorage JSON described in README. */
    const DEFAULTS = {
      notifications: true,
      notifyComplete: true,
      notifyPending: true,
      notifyError: true,
      notifyViewed: false,
      badge: true,
      excludeSubagents: true,
      titleComplete: "DSH 任务完成",
      titlePending: "DSH 需要你确认",
      titleError: "DSH 任务出错",
      maxBodyChars: 140,
    }

    /** Pending-interaction kinds and the body each one gets. */
    const PENDING_BODIES = {
      approval: "有工具调用等你批准",
      question: "有提问等你回答",
      "plan-review": "有执行计划等你确认",
    }

    /** Read the browser storage when this renderer has one. */
    function storage() {
      try {
        return typeof localStorage === "undefined" ? undefined : localStorage
      } catch {
        return undefined
      }
    }

    /** Normalize one stored section; malformed or unknown fields fall back to defaults. */
    function readPreferences() {
      const preferences = { ...DEFAULTS }
      let raw
      try {
        raw = storage()?.getItem(PREFERENCES_KEY)
      } catch {
        raw = undefined
      }
      if (typeof raw !== "string" || raw === "") return preferences
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return preferences
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return preferences
      for (const [key, fallback] of Object.entries(DEFAULTS)) {
        const value = parsed[key]
        if (value === undefined) continue
        if (typeof value !== typeof fallback) continue
        preferences[key] = value
      }
      return preferences
    }

    /** Collapse whitespace and cut to the body budget. */
    function bodyText(text, maxChars) {
      const collapsed = String(text).replace(/\s+/gu, " ").trim()
      if (collapsed.length <= maxChars) return collapsed
      return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`
    }

    /** Whether one status is waiting for a human answer or approval. */
    function pendingKindOf(status) {
      const kind = status?.pendingInteraction?.kind
      return typeof kind === "string" && kind !== "" ? kind : undefined
    }

    /** Whether the main view is currently showing this session. */
    function isViewed(summary) {
      const retained = summary?.retainedBy?.mainView
      return typeof retained === "number" && retained > 0
    }

    /** A session row that belongs to a subagent never gets a banner or a badge. */
    function isSubagent(summary) {
      return summary?.origin === "subagent"
    }

    /** The session title as the body prefix, or a neutral fallback. */
    function describe(summary, maxChars) {
      const title = typeof summary?.title === "string" && summary.title.trim() !== "" ? summary.title.trim() : undefined
      return bodyText(title ?? "会话", maxChars)
    }

    /** Whether this renderer can post a native notification. */
    function canNotify() {
      return typeof Notification !== "undefined" && Notification.permission !== "denied"
    }

    /** Whether this renderer can write the Dock badge. */
    function canBadge() {
      return typeof navigator !== "undefined" && typeof navigator.setAppBadge === "function"
    }

    /** Whether the application window currently has keyboard focus. */
    function windowFocused() {
      try {
        return typeof document === "undefined" || typeof document.hasFocus !== "function" ? true : document.hasFocus()
      } catch {
        return true
      }
    }

    /** Whether the application window is visible (not hidden or minimized). */
    function windowVisible() {
      try {
        return typeof document === "undefined" || document.visibilityState === undefined
          ? true
          : document.visibilityState === "visible"
      } catch {
        return true
      }
    }

    /**
     * "Watching this session" = it is the main view AND the window has focus and
     * is visible. The harness's own `completionUnread` only covers "another
     * session is in the main view"; a backgrounded or hidden window is invisible
     * to the host, so this plugin adds the focus/visibility half itself.
     */
    function isLooking(summary) {
      return isViewed(summary) && windowFocused() && windowVisible()
    }

    /** Ask once for notification permission; Electron normally already granted it. */
    function askPermission() {
      if (typeof Notification === "undefined") return
      try {
        if (Notification.permission === "default") void Notification.requestPermission()
      } catch {
        /* a denied or unavailable permission surface simply leaves banners off */
      }
    }

    const inject = ["sessions", "uiSession"]

    /**
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      const preferences = readPreferences()
      askPermission()

      /** sessionId -> { completed?: true, pendingKind?: string, error?: string } */
      const attention = new Map()
      /** sessionId -> last observed { running, completed, pendingKind }, for edge detection. */
      const previous = new Map()
      let lastBadge
      /** The last banner attempt and its outcome — Windows has several ways to swallow it. */
      let lastNotify

      /** Record why a banner did or did not reach the OS. */
      function recordNotify(entry) {
        lastNotify = { at: new Date().toISOString(), ...entry }
      }

      /** Write the Dock badge only when the number actually changes. */
      function applyBadge() {
        if (!canBadge()) return
        const value = preferences.badge && attention.size > 0 ? attention.size : 0
        if (value === lastBadge) return
        lastBadge = value
        try {
          if (value > 0) void navigator.setAppBadge(value)
          else void navigator.clearAppBadge()
        } catch {
          /* a renderer without badge support keeps running without one */
        }
      }

      /** Post one banner; clicking it opens the session and raises the window. */
      function notify(kind, sessionId, title, body) {
        if (!preferences.notifications) {
          recordNotify({ kind, sessionId, result: "skipped: preferences.notifications=false" })
          return
        }
        if (!canNotify()) {
          const permission = typeof Notification === "undefined" ? "unavailable" : Notification.permission
          recordNotify({ kind, sessionId, result: `skipped: Notification permission=${permission}` })
          return
        }
        let notification
        try {
          notification = new Notification(title, {
            body,
            tag: `${NS}:${kind}:${sessionId}`,
            silent: false,
          })
        } catch (error) {
          recordNotify({ kind, sessionId, result: `threw: ${String(error)}` })
          return
        }
        recordNotify({ kind, sessionId, title, body, result: "posted" })
        notification.onclick = () => {
          try {
            ctx.uiWorkspace?.openSession?.(sessionId)
          } catch {
            /* the window still comes forward when the session cannot be opened */
          }
          try {
            window.focus()
          } catch {
            /* focus is best effort */
          }
          try {
            notification.close()
          } catch {
            /* already gone */
          }
        }
      }

      /** Record one attention fact and drop the session's badge entry when it empties. */
      function setAttention(sessionId, patch) {
        const entry = { ...(attention.get(sessionId) ?? {}), ...patch }
        for (const key of Object.keys(entry)) {
          if (entry[key] === undefined) delete entry[key]
        }
        if (Object.keys(entry).length === 0) attention.delete(sessionId)
        else attention.set(sessionId, entry)
      }

      /** Recompute notifications, attention entries, and the badge from live status. */
      function sync() {
        const statuses = ctx.uiSession.sessionStatus.getSnapshot()
        const summaries = ctx.sessions.list.getSnapshot().byId ?? {}
        const seen = new Set()

        for (const [sessionId, status] of statuses) {
          const summary = summaries[sessionId]
          if (preferences.excludeSubagents && isSubagent(summary)) {
            attention.delete(sessionId)
            previous.delete(sessionId)
            continue
          }
          seen.add(sessionId)
          const before = previous.get(sessionId) ?? {}
          const entry = attention.get(sessionId) ?? {}
          // A failure already recorded for this turn owns the banner and the
          // badge; the `running: true -> false` edge that follows it is the same
          // event, not a second one.
          const failurePending = entry.error !== undefined
          const looking = isLooking(summary)
          const completed = status?.completionUnread === true
          const pendingKind = pendingKindOf(status)
          const running = status?.running === true
          const justFinished = before.running === true && running === false
          const finishedNow = justFinished || (completed && before.completed !== true)
          const completionEdge = finishedNow && !failurePending
          const pendingEdge = pendingKind !== undefined && pendingKind !== before.pendingKind

          if (looking) {
            // You are actually watching this session: an opt-in banner at most,
            // never a badge item, because you have already "read" it.
            if (preferences.notifyViewed && preferences.notifyComplete && completionEdge) {
              notify("complete", sessionId, preferences.titleComplete, `${describe(summary, preferences.maxBodyChars)} · 跑完了`)
            }
            attention.delete(sessionId)
          } else {
            // Not watching — either another session is in the main view or the
            // whole window is in the background: banner plus a persistent badge.
            if (preferences.notifyComplete && completionEdge) {
              notify("complete", sessionId, preferences.titleComplete, `${describe(summary, preferences.maxBodyChars)} · 跑完了，切回来看看`)
            }
            if (preferences.notifyPending && pendingEdge) {
              const body = PENDING_BODIES[pendingKind] ?? "有交互等你处理"
              notify("pending", sessionId, preferences.titlePending, `${describe(summary, preferences.maxBodyChars)} · ${body}`)
            }
            setAttention(sessionId, {
              // Sticky until you look at the session: the edge is the trigger,
              // the unread fact is what keeps the red dot alive.
              completed: completionEdge || completed || entry.completed === true ? true : undefined,
              pendingKind,
              // A new turn clears the failure recorded for the previous one.
              error: running ? undefined : entry.error,
            })
          }

          previous.set(sessionId, { running, completed, pendingKind })
        }

        for (const sessionId of [...attention.keys()]) if (!seen.has(sessionId)) attention.delete(sessionId)
        for (const sessionId of [...previous.keys()]) if (!seen.has(sessionId)) previous.delete(sessionId)
        applyBadge()
      }

      /** A live agent failure: same banner + badge treatment as the three status facts. */
      function onAgentError(sessionId, message) {
        if (typeof sessionId !== "string" || sessionId === "") return
        const summaries = ctx.sessions.list.getSnapshot().byId ?? {}
        const summary = summaries[sessionId]
        if (preferences.excludeSubagents && isSubagent(summary)) return
        if (isLooking(summary)) return
        const text = bodyText(message ?? "未知错误", preferences.maxBodyChars)
        const before = attention.get(sessionId) ?? {}
        setAttention(sessionId, { error: text })
        if (preferences.notifyError && before.error !== text) {
          notify("error", sessionId, preferences.titleError, `${describe(summary, preferences.maxBodyChars)} · 出错：${text}`)
        }
        applyBadge()
      }

      ctx.effect(() => {
        const offStatus = ctx.uiSession.sessionStatus.subscribe(sync)
        const offList = ctx.sessions.list.subscribe(sync)
        sync()
        return () => {
          offStatus()
          offList()
        }
      }, "dsh-plugin-desktop-notify: status watch")

      /*
       * Focus and visibility are the half the host cannot see: a window in the
       * background still shows a session in its main view, so `completionUnread`
       * stays false. Re-evaluate on every focus edge so a banner appears when the
       * app is in the background and the badge clears as soon as you look.
       */
      ctx.effect(() => {
        const reevaluate = () => sync()
        const bindings = []
        const bind = (target, names) => {
          try {
            for (const name of names) target.addEventListener(name, reevaluate)
            bindings.push([target, names])
          } catch {
            /* a target without listeners simply keeps the last known state */
          }
        }
        bind(window, ["focus", "blur"])
        bind(document, ["visibilitychange"])
        return () => {
          for (const [target, names] of bindings) {
            try {
              for (const name of names) target.removeEventListener(name, reevaluate)
            } catch {
              /* already detached */
            }
          }
        }
      }, "dsh-plugin-desktop-notify: focus watch")

      ctx.effect(() => {
        let remote
        try {
          remote = ctx.get === undefined ? ctx.remote : ctx.get("remote")
        } catch {
          remote = undefined
        }
        if (remote === undefined || typeof remote.$on !== "function") return
        const off = remote.$on("api-session/error", onAgentError)
        return () => {
          if (typeof off === "function") off()
        }
      }, "dsh-plugin-desktop-notify: failure watch")

      ctx.effect(() => () => {
        try {
          if (canBadge()) void navigator.clearAppBadge()
        } catch {
          /* nothing to clear */
        }
      }, "dsh-plugin-desktop-notify: badge release")

      /*
       * Diagnostic surface for DevTools (⌘⌥I):
       *   __DSH_DESKTOP_NOTIFY__.capabilities()      — what this renderer supports
       *   __DSH_DESKTOP_NOTIFY__.state()             — live attention + badge
       *   __DSH_DESKTOP_NOTIFY__.simulateComplete()  — banner + badge, end to end
       *   __DSH_DESKTOP_NOTIFY__.reset()             — undo the simulation
       */
      const diagnostics = {
        version: NS,
        capabilities() {
          return {
            platform: (() => {
              try {
                return navigator.userAgentData?.platform ?? navigator.platform ?? "unknown"
              } catch {
                return "unknown"
              }
            })(),
            notification: typeof Notification === "undefined" ? "unavailable" : Notification.permission,
            badge: canBadge(),
            remote: (() => {
              try {
                return ctx.get === undefined ? typeof ctx.remote : typeof ctx.get("remote")
              } catch {
                return "unavailable"
              }
            })(),
            preferences,
          }
        },
        state() {
          return {
            badge: lastBadge ?? 0,
            attention: [...attention.entries()].map(([sessionId, entry]) => ({ sessionId, ...entry })),
            tracked: [...previous.keys()],
            lastNotify: lastNotify ?? null,
          }
        },
        simulateComplete(sessionId = "desktop-notify-simulation") {
          setAttention(sessionId, { completed: true })
          notify("complete", sessionId, preferences.titleComplete, "模拟会话 · 跑完了，切回来看看")
          applyBadge()
          return this.state()
        },
        reset() {
          attention.clear()
          lastBadge = undefined
          applyBadge()
          return this.state()
        },
        testBadge(count = 3) {
          if (!canBadge()) return "navigator.setAppBadge 不可用"
          try {
            void navigator.setAppBadge(count)
            return `ok: ${count}`
          } catch (error) {
            return String(error)
          }
        },
        testNotification() {
          if (!canNotify()) {
            return `Notification 不可用（${typeof Notification === "undefined" ? "undefined" : Notification.permission}）`
          }
          try {
            const probe = new Notification("DSH 通知自检", { body: "这条来自插件自检，不是任务通知" })
            probe.onclick = () => window.focus()
            return "ok"
          } catch (error) {
            return String(error)
          }
        },
      }
      try {
        window.__DSH_DESKTOP_NOTIFY__ = diagnostics
        console.info(`[desktop-notify] loaded — ${JSON.stringify(diagnostics.capabilities())}`)
      } catch {
        /* a locked-down window simply leaves the diagnostics unset */
      }
    }

    return { inject, apply }
  },
})
