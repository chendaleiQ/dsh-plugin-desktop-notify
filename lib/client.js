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
    /** Reported by capabilities(); keep in step with package.json (cross-machine support). */
    const VERSION = "0.5.6"
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
      // Empty means "use the built-in copy for the active UI language".
      titleComplete: "",
      titlePending: "",
      titleError: "",
      maxBodyChars: 140,
    }

    /**
     * Notification copy. Terse product language, mirroring how the app itself
     * words things; the language follows the UI (`<html lang>`), not the OS.
     */
    const COPY = {
      zh: {
        completeTitle: "任务已完成",
        complete: (name, duration) => withName(name, duration === "" ? "已完成" : `已完成，用时 ${duration}`),
        approvalTitle: "等待你的批准",
        approval: (name, tool) => withName(name, tool === "" ? "有一项操作等待你批准" : `请求使用 ${tool}，等待你的批准`),
        questionTitle: "等待你的回答",
        question: (name) => withName(name, "有提问等待你回复"),
        planTitle: "等待你的确认",
        plan: (name) => withName(name, "执行计划等待你确认"),
        errorTitle: "任务执行失败",
        error: (name, message) => withName(name, message === "" ? "执行中断" : message),
        seconds: (value) => `${value} 秒`,
        minutes: (minutes, seconds) => (seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`),
        hours: (hours, minutes) => (minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分`),
      },
      en: {
        completeTitle: "Task completed",
        complete: (name, duration) => withName(name, duration === "" ? "Completed" : `Completed in ${duration}`),
        approvalTitle: "Approval needed",
        approval: (name, tool) => withName(name, tool === "" ? "A tool is waiting for your approval" : `${tool} is waiting for your approval`),
        questionTitle: "Your reply is needed",
        question: (name) => withName(name, "A question is waiting for your reply"),
        planTitle: "Plan review needed",
        plan: (name) => withName(name, "The execution plan is waiting for your review"),
        errorTitle: "Task failed",
        error: (name, message) => withName(name, message === "" ? "The run was interrupted" : message),
        seconds: (value) => `${value}s`,
        minutes: (minutes, seconds) => (seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`),
        hours: (hours, minutes) => (minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`),
      },
    }

    /** Prefix the state sentence with the session name, when the session has one. */
    function withName(name, text) {
      return name === "" ? text : `「${name}」${text}`
    }

    /** The UI language before the app's locale service answers: `<html lang>`, then the browser. */
    function activeLanguage() {
      try {
        const html = typeof document === "undefined" ? "" : document.documentElement?.lang ?? ""
        const declared = String(html !== "" ? html : (typeof navigator === "undefined" ? "" : navigator.language) ?? "").toLowerCase()
        if (declared.startsWith("zh")) return "zh"
        if (declared !== "") return "en"
      } catch {
        /* fall through to the default */
      }
      return "zh"
    }

    /** The copy table for one UI language. */
    function copy(language) {
      return COPY[language] ?? COPY.zh
    }

    /** Compact elapsed time: "42 秒" / "3 分 12 秒" / "1 小时 5 分". */
    function durationText(milliseconds, language) {
      const table = copy(language)
      const total = Math.max(1, Math.round(milliseconds / 1000))
      if (total < 60) return table.seconds(total)
      const minutes = Math.floor(total / 60)
      if (minutes < 60) return table.minutes(minutes, total % 60)
      return table.hours(Math.floor(minutes / 60), minutes % 60)
    }

    /** Pending-interaction kinds the plugin reports. */
    const PENDING_KINDS = ["approval", "question", "plan-review"]

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

    /** The tool a pending approval names, when the interaction carries one. */
    function pendingToolName(status) {
      const tool = status?.pendingInteraction?.toolName
      return typeof tool === "string" ? tool.trim() : ""
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
    function sessionName(summary, maxChars) {
      const title = typeof summary?.title === "string" ? summary.title.trim() : ""
      return title === "" ? "" : bodyText(title, maxChars)
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

    const inject = ["sessions", "uiSession", "uiWorkspace", "locale"]

    /**
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      /**
       * The app's own language, in the order DSH resolves it: the locale service
       * (Settings → General), then `<html lang>`, then the browser. Chinese is
       * the default; English is the only other language this plugin ships.
       */
      const languageOf = () => {
        try {
          const active = String(ctx.locale?.getSnapshot?.().active ?? "").toLowerCase()
          if (active.startsWith("zh")) return "zh"
          if (active.startsWith("en")) return "en"
        } catch {
          /* an older host without the locale service falls back below */
        }
        return activeLanguage()
      }

      const preferences = readPreferences()
      askPermission()

      /** sessionId -> { completed?: true, pendingKind?: string, error?: string } */
      const attention = new Map()
      /** sessionId -> last observed { running, completed, pendingKind }, for edge detection. */
      const previous = new Map()
      /** sessionId -> ms timestamp when the current turn was first seen running. */
      const turnStartedAt = new Map()
      let lastBadge
      /** The last banner attempt and its outcome — Windows has several ways to swallow it. */
      let lastNotify
      /** The last banner click and what it managed to do — Windows/macOS differ here. */
      let lastClick

      /** Record why a banner did or did not reach the OS. */
      function recordNotify(entry) {
        lastNotify = {
          at: new Date().toISOString(),
          permission: typeof Notification === "undefined" ? "unavailable" : Notification.permission,
          ...entry,
        }
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

      /**
       * Open one session in the main view. `uiWorkspace` is the service the sidebar
       * uses; older builds may only expose it through `ctx.get`, so try both and
       * report what happened instead of swallowing a failure.
       */
      function openSessionTarget(sessionId) {
        if (typeof sessionId !== "string" || sessionId === "") return { ok: false, attempts: ["empty session id"] }
        const candidates = []
        try {
          if (typeof ctx.uiWorkspace?.openSession === "function") candidates.push(["ctx.uiWorkspace (injected)", ctx.uiWorkspace])
        } catch (error) {
          candidates.push(["ctx.uiWorkspace", `unavailable: ${String(error)}`])
        }
        try {
          if (ctx.uiWorkspace !== undefined) candidates.push(["ctx.uiWorkspace", ctx.uiWorkspace])
        } catch {
          candidates.push(["ctx.uiWorkspace", "unavailable"])
        }
        try {
          const resolved = typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined
          if (resolved !== undefined) candidates.push(["ctx.get('uiWorkspace')", resolved])
        } catch {
          candidates.push(["ctx.get('uiWorkspace')", "unavailable"])
        }
        const attempts = []
        for (const [name, service] of candidates) {
          if (typeof service?.openSession !== "function") {
            attempts.push(`${name}: no openSession`)
            continue
          }
          try {
            service.openSession(sessionId)
            return { ok: true, via: name, attempts }
          } catch (error) {
            attempts.push(`${name}: ${String(error)}`)
          }
        }
        if (candidates.length === 0) attempts.push("uiWorkspace service is not reachable")
        return { ok: false, attempts }
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
          // No `tag` and no `silent`: Windows 11 silently drops web notifications
          // whose tag is longer than ~34 characters (electron/electron#40433), and
          // a long per-session tag was exactly what this used to pass. Edge-based
          // dedupe below already prevents the same banner firing twice.
          notification = new Notification(title, { body })
        } catch (error) {
          recordNotify({ kind, sessionId, result: `threw: ${String(error)}` })
          return
        }
        recordNotify({ kind, sessionId, title, body, result: "posted" })
        notification.onclick = () => {
          // Raise the window first: the navigation below is a layout operation and
          // behaves best on an active window.
          let focused = false
          try {
            window.focus()
            focused = true
          } catch {
            /* focus is best effort */
          }
          const opened = openSessionTarget(sessionId)
          lastClick = {
            at: new Date().toISOString(),
            kind,
            sessionId,
            opened,
            focused,
          }
          // A window that was closed to the tray can swallow the first attempt;
          // retry once after the OS finishes activating the application.
          if (!opened.ok) {
            setTimeout(() => {
              const retry = openSessionTarget(sessionId)
              lastClick = { ...lastClick, retried: retry }
            }, 150)
          }
          // Windows applies foreground changes asynchronously and may swallow the
          // first attempt; retry the raise without touching the selected session.
          for (const delay of [60, 300]) {
            setTimeout(() => {
              try {
                window.focus()
              } catch {
                /* focus is best effort */
              }
            }, delay)
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

          if (running) {
            if (!turnStartedAt.has(sessionId)) turnStartedAt.set(sessionId, Date.now())
          }

          const table = copy(languageOf())
          const name = sessionName(summary, preferences.maxBodyChars)

          if (completionEdge) {
            const started = turnStartedAt.get(sessionId)
            turnStartedAt.delete(sessionId)
            const duration = started === undefined ? "" : durationText(Date.now() - started, languageOf())
            const title = preferences.titleComplete || table.completeTitle
            const body = bodyText(table.complete(name, duration), preferences.maxBodyChars)
            if (looking) {
              // Watching it finish is only worth a banner when the user opted in.
              if (preferences.notifyViewed && preferences.notifyComplete) notify("complete", sessionId, title, body)
            } else if (preferences.notifyComplete) {
              notify("complete", sessionId, title, body)
            }
          }

          if (looking) {
            // Reading the session drops every fact for it, so the badge falls back.
            attention.delete(sessionId)
          } else {
            if (preferences.notifyPending && pendingEdge) {
              const tool = pendingKind === "approval" ? pendingToolName(status) : ""
              const body = pendingKind === "approval"
                ? table.approval(name, tool)
                : pendingKind === "plan-review"
                  ? table.plan(name)
                  : table.question(name)
              const title = preferences.titlePending || (pendingKind === "approval" ? table.approvalTitle : pendingKind === "plan-review" ? table.planTitle : table.questionTitle)
              notify("pending", sessionId, title, bodyText(body, preferences.maxBodyChars))
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
        for (const sessionId of [...previous.keys()]) if (!seen.has(sessionId)) {
          previous.delete(sessionId)
          turnStartedAt.delete(sessionId)
        }
        applyBadge()
      }

      /** A live agent failure: same banner + badge treatment as the three status facts. */
      function onAgentError(sessionId, message) {
        if (typeof sessionId !== "string" || sessionId === "") return
        const summaries = ctx.sessions.list.getSnapshot().byId ?? {}
        const summary = summaries[sessionId]
        if (preferences.excludeSubagents && isSubagent(summary)) return
        if (isLooking(summary)) return
        const table = copy(languageOf())
        const raw = typeof message === "string" ? message.trim() : ""
        const text = bodyText(raw, preferences.maxBodyChars)
        const before = attention.get(sessionId) ?? {}
        turnStartedAt.delete(sessionId)
        setAttention(sessionId, { error: text === "" ? "中断" : text })
        if (preferences.notifyError && before.error !== text) {
          const title = preferences.titleError || table.errorTitle
          const body = bodyText(table.error(sessionName(summary, preferences.maxBodyChars), text), preferences.maxBodyChars)
          notify("error", sessionId, title, body)
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
        version: VERSION,
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
            workspace: (() => {
              try {
                if (typeof ctx.uiWorkspace?.openSession === "function") return "available"
                return "missing"
              } catch (error) {
                return `unavailable: ${String(error)}`
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
            lastClick: lastClick ?? null,
          }
        },
        simulateComplete(sessionId = "desktop-notify-simulation") {
          const table = copy(languageOf())
          setAttention(sessionId, { completed: true })
          notify("complete", sessionId, preferences.titleComplete || table.completeTitle, table.complete("", durationText(12000, languageOf())))
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
        /**
         * One-line support report: version, capabilities, live state, and what the
         * last banner click actually did. Copied to the clipboard when possible.
         */
        report() {
          const payload = {
            version: VERSION,
            capabilities: this.capabilities(),
            state: this.state(),
            window: { focus: windowFocused(), visible: windowVisible(), visibility: (() => {
              try {
                return typeof document === "undefined" ? "unknown" : document.visibilityState ?? "unknown"
              } catch {
                return "unknown"
              }
            })() },
          }
          const text = JSON.stringify(payload, null, 2)
          try {
            navigator.clipboard?.writeText?.(text)?.catch?.(() => {})
          } catch {
            /* clipboard is optional */
          }
          return text
        },
        /** Try to open a session directly, the same way a banner click does. */
        openSession(sessionId) {
          const result = openSessionTarget(String(sessionId ?? ""))
          try {
            window.focus()
          } catch {
            /* focus is best effort */
          }
          return result
        },
        /** Fire the plugin's real delivery path (tag + silent), so its options can be compared. */
        testNotifyPath() {
          notify("probe", "desktop-notify-probe", "DSH 通知自检（插件路径）", "这条走插件真实的 notify()，带 tag/silent 参数")
          return lastNotify ?? null
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
