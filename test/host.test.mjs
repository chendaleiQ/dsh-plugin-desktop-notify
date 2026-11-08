import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync, readFileSync } from "node:fs"

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

const pinsFile = `/tmp/dsh-notify-pins-${process.pid}.json`

apply(ctx, {
  onlyWhenUnfocused: false,
  sound: false,
  dryRun: true,
  logPath: log,
  pinsPath: pinsFile,
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
  // The same dispatcher: one Host, one event bus; the second row only adds routes.
  on(name, callback) {
    return ctx.on(name, callback)
  },
  get(name) {
    return name === "webServer" ? webServer : undefined
  },
  effect(factory) {
    const dispose = factory()
    return () => dispose?.()
  },
}

apply(apiCtx, { enabled: false, api: true, endpointPath: endpointFile, pinsPath: pinsFile, logPath: "/tmp/dsh-notify-api.log", dryRun: true })
await sleep(50)
assert.equal(routes.has("/desktop-notify/request"), true, "the POST route is registered")
assert.equal(routes.has("/desktop-notify/pending"), true, "the drain route is registered")
assert.equal(routes.has("/desktop-notify/turn"), true, "the turn-kind route is registered")
assert.equal(routes.has("/desktop-notify/pins"), true, "the pins route is registered")

function call(path, method, payload, token) {
  const [routePath, query] = path.split("?")
  const search = new URLSearchParams(query ?? "")
  if (token !== undefined) search.set("token", token)
  const suffix = search.toString()
  const req = Object.assign(new EventEmitter(), {
    method,
    url: suffix === "" ? routePath : `${routePath}?${suffix}`,
    headers: {},
  })
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
  routes.get(routePath).handler(req, res)
  if (payload !== undefined) {
    queueMicrotask(() => {
      req.emit("data", Buffer.from(JSON.stringify(payload)))
      req.emit("end")
    })
  }
  return res
}

const endpoint = readFileSync(endpointFile, "utf8").trim()
assert.ok(endpoint.startsWith("http://127.0.0.1:4567/desktop-notify/request?token="), `the endpoint carries the address and a token: ${endpoint}`)
const token = new URL(endpoint).searchParams.get("token")

const unauthorized = call("/desktop-notify/request", "POST", { title: "x", body: "y" })
await sleep(80)
assert.equal(unauthorized.status, 401, "a request without the token is refused")

const accepted = call("/desktop-notify/request", "POST", { title: "neo 需要你", body: "有一个接管请求" }, token)
await sleep(80)
assert.equal(accepted.status, 202, "a valid request is accepted")

const drained = call("/desktop-notify/pending", "GET")
const items = JSON.parse(drained.body)
assert.equal(items.length, 1)
assert.equal(items[0].title, "neo 需要你")
assert.equal(items[0].body, "有一个接管请求")

const empty = call("/desktop-notify/pending", "GET")
assert.deepEqual(JSON.parse(empty.body), [], "draining empties the queue")

const rejected = call("/desktop-notify/request", "POST", { body: "" }, token)
await sleep(80)
assert.equal(rejected.status, 400, "an empty request is refused")

emit("session/event", main, { type: "turn/end", data: { turn: 4, reason: { kind: "aborted" } } })
const turn = call("/desktop-notify/turn?sessionId=session-main", "GET")
assert.equal(JSON.parse(turn.body).kind, "aborted", `the renderer can ask how the last turn ended: ${turn.body}`)

// ---- the interface waits for a web server that activates later -------------
{
  const lateRoutes = new Map()
  let activate
  const lateEndpoint = `/tmp/dsh-notify-late-${process.pid}`
  const deferredCtx = {
    on() {
      return () => {}
    },
    effect(factory) {
      const dispose = factory()
      return () => dispose?.()
    },
    inject(names, callback) {
      assert.deepEqual([...names], ["webServer"], "the interface injects the web server")
      activate = () => callback({
        get: () => undefined,
        effect(factory) {
          const dispose = factory()
          return () => dispose?.()
        },
        webServer: {
          register(route) {
            lateRoutes.set(route.path, route)
            return () => lateRoutes.delete(route.path)
          },
          getOrigin() {
            return "http://127.0.0.1:9999"
          },
        },
      })
    },
  }
  apply(deferredCtx, { enabled: false, api: true, endpointPath: lateEndpoint, pinsPath: `/tmp/dsh-notify-late-pins-${process.pid}.json`, logPath: "/tmp/dsh-notify-late.log", dryRun: true })
  await sleep(20)
  assert.equal(existsSync(lateEndpoint), false, "no endpoint file before the web server exists")
  activate()
  await sleep(60)
  assert.equal(lateRoutes.has("/desktop-notify/request"), true, "the routes mount once the web server arrives")
  assert.ok(readFileSync(lateEndpoint, "utf8").includes("/desktop-notify/request?token="), "the endpoint appears once the web server arrives")
}

const emptyPins = call("/desktop-notify/pins", "GET")
assert.deepEqual(JSON.parse(emptyPins.body), { ids: [] }, "no pins are remembered at first")

const saved = call("/desktop-notify/pins", "POST", { ids: ["s-keep", 42, ""] })
await sleep(80)
assert.equal(saved.status, 200, "the pin set is accepted")
const readBack = call("/desktop-notify/pins", "GET")
assert.deepEqual(JSON.parse(readBack.body), { ids: ["s-keep"] }, "only string ids survive the round trip")
assert.deepEqual(JSON.parse(readFileSync(pinsFile, "utf8")), { ids: ["s-keep"] }, "and are written to disk")

console.log("host interface: ok")
