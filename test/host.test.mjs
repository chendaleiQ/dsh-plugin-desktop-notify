import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
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


// ---- local notification interface -------------------------------------------
const routes = new Map()
const endpointFile = `/tmp/dsh-notify-endpoint-${process.pid}`
const webServer = {
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
  getOrigin() {
    return "http://127.0.0.1:4567"
  },
}
const apiCtx = {
  on() {
    return () => {}
  },
  get(name) {
    return name === "webServer" ? webServer : undefined
  },
  effect(factory) {
    const dispose = factory()
    return () => dispose?.()
  },
}

apply(apiCtx, { enabled: false, api: true, endpointPath: endpointFile, logPath: "/tmp/dsh-notify-api.log", dryRun: true })
await sleep(50)
assert.equal(routes.has("/desktop-notify/request"), true, "the POST route is registered")
assert.equal(routes.has("/desktop-notify/pending"), true, "the drain route is registered")
assert.equal(readFileSync(endpointFile, "utf8").trim(), "http://127.0.0.1:4567/desktop-notify/request")

function call(path, method, payload) {
  const req = Object.assign(new EventEmitter(), { method })
  const res = {
    status: 0,
    body: "",
    writeHead(code) {
      this.status = code
    },
    end(body) {
      this.body = body
    },
  }
  routes.get(path).handler(req, res)
  if (payload !== undefined) {
    queueMicrotask(() => {
      req.emit("data", Buffer.from(JSON.stringify(payload)))
      req.emit("end")
    })
  }
  return res
}

const accepted = call("/desktop-notify/request", "POST", { title: "neo 需要你", body: "有一个接管请求" })
await sleep(80)
assert.equal(accepted.status, 202, "a valid request is accepted")

const drained = call("/desktop-notify/pending", "GET")
const items = JSON.parse(drained.body)
assert.equal(items.length, 1)
assert.equal(items[0].title, "neo 需要你")
assert.equal(items[0].body, "有一个接管请求")

const empty = call("/desktop-notify/pending", "GET")
assert.deepEqual(JSON.parse(empty.body), [], "draining empties the queue")

const rejected = call("/desktop-notify/request", "POST", { body: "" })
await sleep(80)
assert.equal(rejected.status, 400, "an empty request is refused")

console.log("host interface: ok")
