import { readFileSync } from "node:fs"

const log = process.argv[2] ?? "/tmp/dsh-notify-test.log"
const handlers = new Map()

const ctx = {
  on(name, callback) {
    if (!handlers.has(name)) handlers.set(name, [])
    handlers.get(name).push(callback)
    return () => {}
  },
}

const { apply } = await import("../index.js")

function emit(name, ...args) {
  for (const callback of handlers.get(name) ?? []) callback(...args)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function session(id, header) {
  return { id, header }
}

const main = session("session-main", { version: 4, id: "session-main", createdAt: 1, cwd: "/Users/u/Desktop/mine" })
const child = session("session-child", { version: 4, id: "session-child", createdAt: 2, cwd: "/Users/u/Desktop/mine", parentSession: "session-main", origin: "subagent" })

apply(ctx, {
  onlyWhenUnfocused: false,
  sound: false,
  dryRun: true,
  logPath: log,
})

emit("session/event", main, {
  type: "assistant/message",
  data: { turn: 1, step: 0, message: { role: "assistant", content: [{ type: "text", text: "已修好 `hooks` 里的通知逻辑，\n顺带补了测试。" }] } },
})
emit("session/event", main, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } })

emit("session/event", main, { type: "turn/end", data: { turn: 2, reason: { kind: "error", error: { message: "rate limited", code: "RATE_LIMITED" } } } })
emit("session/event", main, { type: "approval/asked", data: { id: "a1", toolName: "Bash", reason: "delete build output" } })
emit("session/event", main, { type: "turn/end", data: { turn: 3, reason: { kind: "aborted" } } })

emit("session/event", child, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } })

await sleep(900)
emit("session/disposed", main)

console.log(readFileSync(log, "utf8"))
