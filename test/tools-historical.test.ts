// test/tools-historical.test.ts
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG, type StmConfig } from "../src/config.js"
import { createOperationGuard, createStateStore, hashSessionID, hashTitle, initialMeta } from "../src/state.js"
import { createRootCache } from "../src/sdk.js"
import { createTranscriptQueue } from "../src/transcript.js"
import { createHistoricalTools, type StmServices } from "../src/tools.js"
import { fakeClient, headerResponse, type FakeHandler } from "./fakes.js"

const TRANSCRIPT_SENTINEL = "STM_TRANSCRIPT_SENTINEL_4321"

const createdDirs: string[] = []

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
})

function historicalConfig(overrides: Partial<StmConfig["historical"]>): StmConfig {
  return { ...DEFAULT_CONFIG, historical: { ...DEFAULT_CONFIG.historical, ...overrides } }
}

function context(sessionID = "ses_caller", controller = new AbortController()): ToolContext & { asks: any[] } {
  const asks: any[] = []
  return {
    sessionID,
    messageID: "msg_tool",
    agent: "build",
    directory: "/tmp",
    worktree: "/tmp",
    abort: controller.signal,
    metadata() {},
    ask: async (input: any) => {
      asks.push(input)
    },
    asks,
  } as ToolContext & { asks: any[] }
}

function makeServices(
  config: StmConfig,
  handlers: { get?: FakeHandler; update?: FakeHandler; messages?: FakeHandler } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "stm-history-"))
  createdDirs.push(dir)
  const { client, calls } = fakeClient({
    get: handlers.get ?? (async (options: any) => ({ data: { id: options.path.id, title: "Historical title" } })),
    update: handlers.update ?? (async (options: any) => ({ data: { id: options.path.id, title: options.body.title } })),
    messages: handlers.messages ?? (async () => ({ data: [], response: headerResponse("x-next-cursor", null) })),
  })
  const services: StmServices = {
    client,
    config,
    state: createStateStore({ stateDir: dir }),
    queue: createTranscriptQueue(),
    roots: createRootCache(client),
    guard: createOperationGuard(),
    blocked: new Map(),
    now: () => 0,
  }
  return { services, calls, dir }
}

function targetStatePath(dir: string, sessionID: string): string {
  return join(dir, `${hashSessionID(sessionID)}.json`)
}

async function execute(tools: Record<string, any>, name: string, args: unknown, ctx: ToolContext) {
  return JSON.parse(String(await tools[name]!.execute(args as any, ctx)))
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

test("historical flags expose exactly their own tools", () => {
  const none = createHistoricalTools(makeServices(DEFAULT_CONFIG).services)
  assert.deepEqual(Object.keys(none), [])

  const renames = createHistoricalTools(makeServices(historicalConfig({ renameTitles: true })).services)
  assert.deepEqual(Object.keys(renames), ["stm_history_title_rename"])
  assert.equal("stm_history_title_read" in renames, false)

  const transcript = createHistoricalTools(makeServices(historicalConfig({ readTranscript: true })).services)
  assert.deepEqual(Object.keys(transcript).sort(), ["stm_history_review_end", "stm_history_transcript"])
})

test("historical title read asks first and never targets the caller", async () => {
  const { services, calls } = makeServices(historicalConfig({ readTitles: true }))
  const tools = createHistoricalTools(services)
  const self = await execute(tools, "stm_history_title_read", { sessionID: "ses_caller" }, context())
  assert.equal(self.status, "invalid")
  assert.equal(self.reason, "self-target")
  assert.equal(calls.length, 0)

  const ctx = context()
  const result = await execute(tools, "stm_history_title_read", { sessionID: "ses_target" }, ctx)
  assert.equal(result.status, "ok")
  assert.equal(result.title, "Historical title")
  assert.equal(result.root, true)
  assert.deepEqual(ctx.asks[0], {
    permission: "stm_history_title_read",
    patterns: ["ses_target"],
    always: [],
    metadata: {},
  })
})

test("historical read denied performs no target read after the ask", async () => {
  const { services, calls } = makeServices(historicalConfig({ readTitles: true }))
  const tools = createHistoricalTools(services)
  const ctx = context()
  let callsDuringAsk = -1
  ctx.ask = async () => {
    callsDuringAsk = calls.length
    throw new Error("denied")
  }
  const result = await execute(tools, "stm_history_title_read", { sessionID: "ses_target" }, ctx)
  assert.equal(result.status, "denied")
  assert.equal(callsDuringAsk, 1, "only the caller root probe ran before the ask")
  assert.equal(calls.length, callsDuringAsk, "no SDK call after the denied ask")
})

test("historical read with abort makes no SDK call", async () => {
  const { services, calls } = makeServices(historicalConfig({ readTitles: true }))
  const tools = createHistoricalTools(services)
  const controller = new AbortController()
  controller.abort()
  const result = await execute(
    tools,
    "stm_history_title_read",
    { sessionID: "ses_target" },
    context("ses_caller", controller),
  )
  assert.equal(result.status, "aborted")
  assert.equal(calls.length, 0)
})

test("historical rename rejects a child target and locks the target after success", async () => {
  const now = { title: "Old title" }
  const { services, calls, dir } = makeServices(historicalConfig({ renameTitles: true }), {
    get: async (options: any) =>
      options.path.id === "ses_child"
        ? { data: { id: "ses_child", title: "Child", parentID: "ses_target" } }
        : { data: { id: options.path.id, title: now.title } },
    update: async (options: any) => {
      now.title = options.body.title
      return { data: { id: options.path.id, title: now.title } }
    },
  })
  const tools = createHistoricalTools(services)
  const child = await execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_child", expectedTitle: "Child", title: "New" },
    context(),
  )
  assert.equal(child.status, "conflict")
  assert.equal(child.reason, "child-target")
  const ctx = context()
  const ok = await execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_target", expectedTitle: "Old title", title: "Approved title" },
    ctx,
  )
  assert.equal(ok.status, "ok")
  assert.deepEqual(ctx.asks[0], {
    permission: "stm_history_title_rename",
    patterns: ["ses_target"],
    always: [],
    metadata: { expectedTitle: "Old title", newTitle: "Approved title" },
  })
  const updates = calls.filter((call) => call.method === "update")
  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0]?.options.body, { title: "Approved title" })
  const targetState = JSON.parse(readFileSync(targetStatePath(dir, "ses_target"), "utf8"))
  assert.equal(targetState.locked, true)
  assert.equal(targetState.lockReason, "historical")
  assert.equal(targetState.titleDigest, hashTitle("Approved title"))
})

test("historical rename locks the latest target metadata and preserves concurrent fields", async () => {
  let title = "Historical title"
  const { services, dir } = makeServices(historicalConfig({ renameTitles: true }), {
    get: async (options: any) => ({ data: { id: options.path.id, title } }),
    update: async (options: any) => {
      title = String(options.body.title)
      return { data: { id: options.path.id, title } }
    },
  })
  await services.state.save("ses_target", {
    ...initialMeta(),
    activity: 7,
    baselineMessageID: "m7",
    frontier: ["m1", "m2"],
  })
  const tools = createHistoricalTools(services)
  const result = await execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_target", expectedTitle: "Historical title", title: "Approved title" },
    context(),
  )
  assert.equal(result.status, "ok")
  const state = JSON.parse(readFileSync(targetStatePath(dir, "ses_target"), "utf8"))
  assert.equal(state.locked, true)
  assert.equal(state.lockReason, "historical")
  assert.equal(state.titleDigest, hashTitle("Approved title"))
  assert.equal(state.activity, 7)
  assert.deepEqual(state.frontier, ["m1", "m2"])
  assert.equal(state.baselineMessageID, "m7")
})

test("rename expected title mismatch keeps target state", async () => {
  const { services, calls, dir } = makeServices(historicalConfig({ renameTitles: true }))
  const tools = createHistoricalTools(services)
  const result = await execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_target", expectedTitle: "Wrong", title: "New" },
    context(),
  )
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "expected-title-mismatch")
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
  assert.equal(existsSync(targetStatePath(dir, "ses_target")), false)
})

test("rename read-back mismatch is uncertain and does not lock", async () => {
  let updates = 0
  const { services, dir } = makeServices(historicalConfig({ renameTitles: true }), {
    get: async (options: any) => ({ data: { id: options.path.id, title: "Historical title" } }),
    update: async (options: any) => {
      updates += 1
      return { data: { id: options.path.id, title: "Different title" } }
    },
  })
  const tools = createHistoricalTools(services)
  const result = await execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_target", expectedTitle: "Historical title", title: "Approved title" },
    context(),
  )
  assert.equal(result.status, "uncertain")
  assert.equal(updates, 1)
  assert.equal(existsSync(targetStatePath(dir, "ses_target")), false)
})

test("a queued historical rename conflicts when the first rename changes the title", async () => {
  let title = "Old title"
  let gated = true
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { services, calls } = makeServices(historicalConfig({ renameTitles: true }), {
    get: async (options: any) => {
      if (options.path.id === "ses_target" && gated) {
        gated = false
        await gate
      }
      return { data: { id: options.path.id, title } }
    },
    update: async (options: any) => {
      title = String(options.body.title)
      return { data: { id: options.path.id, title } }
    },
  })
  const tools = createHistoricalTools(services)
  const first = execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_target", expectedTitle: "Old title", title: "First title" },
    context(),
  )
  await new Promise((resolve) => setImmediate(resolve))
  const second = execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_target", expectedTitle: "Old title", title: "Second title" },
    context(),
  )
  await new Promise((resolve) => setImmediate(resolve))
  release()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.status, "ok")
  assert.equal(firstResult.title, "First title")
  assert.equal(secondResult.status, "conflict")
  assert.equal(secondResult.reason, "expected-title-mismatch")
  assert.equal(calls.filter((call) => call.method === "update").length, 1)
})

test("transcript acknowledgements carry counts and cursors but never text", async () => {
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => ({
      data: [
        { info: { id: "m1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: TRANSCRIPT_SENTINEL }] },
      ],
      response: headerResponse("x-next-cursor", null),
    }),
  })
  const tools = createHistoricalTools(services)
  const ctx = context()
  const result = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, ctx)
  assert.equal(result.status, "ok")
  assert.equal(result.bytes > 0, true)
  assert.equal(result.complete, true)
  assert.equal(result.cursor, null)
  assert.deepEqual(Object.keys(result).sort(), [
    "bytes",
    "complete",
    "continuation",
    "cursor",
    "messages",
    "more",
    "plugin",
    "sessionID",
    "status",
  ])
  assert.equal(JSON.stringify(result).includes(TRANSCRIPT_SENTINEL), false)
  assert.deepEqual(ctx.asks[0].metadata, {})
  const pageCalls = calls.filter((call) => call.method === "messages")
  assert.equal(pageCalls.length, 1)
  assert.deepEqual(pageCalls[0]?.options.query, { limit: 8 })

  // A cursor that was never issued to this caller is rejected before any page fetch.
  const foreign = await execute(
    tools,
    "stm_history_transcript",
    { sessionID: "ses_target", cursor: "foreign" },
    context("ses_other"),
  )
  assert.equal(foreign.status, "conflict")
  assert.match(foreign.reason, /cursor/)
  assert.equal(calls.filter((call) => call.method === "messages").length, 1)
})

test("transcript asks with empty metadata", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }))
  const tools = createHistoricalTools(services)
  const ctx = context()
  const result = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, ctx)
  assert.equal(result.status, "ok")
  assert.deepEqual(ctx.asks[0], {
    permission: "stm_history_transcript",
    patterns: ["ses_target"],
    always: [],
    metadata: {},
  })
})

test("transcript rejects a child target after permission", async () => {
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    get: async (options: any) =>
      options.path.id === "ses_child"
        ? { data: { id: "ses_child", title: "Child", parentID: "ses_parent" } }
        : { data: { id: options.path.id, title: "Historical title" } },
  })
  const tools = createHistoricalTools(services)
  const ctx = context()
  const result = await execute(tools, "stm_history_transcript", { sessionID: "ses_child" }, ctx)
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "child-target")
  assert.equal(ctx.asks.length, 1, "permission is asked before the target is read")
  assert.equal(calls.filter((call) => call.method === "messages").length, 0)
})

test("transcript cursor mismatch is a conflict", async () => {
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => ({
      data: [
        { info: { id: "m1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "partial" }] },
      ],
      response: headerResponse("x-next-cursor", "cur-1"),
    }),
  })
  const tools = createHistoricalTools(services)
  const first = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(first.status, "ok")
  assert.equal(first.cursor, "cur-1")
  assert.equal(first.complete, false)
  assert.equal(first.more, true)
  // Simulate delivery of the pending chunk by the outgoing transform.
  assert.notEqual(services.queue.take("ses_caller", 0), null)
  const mismatched = await execute(
    tools,
    "stm_history_transcript",
    { sessionID: "ses_target", cursor: "foreign" },
    context(),
  )
  assert.equal(mismatched.status, "conflict")
  assert.match(mismatched.reason, /cursor/)
  assert.equal(calls.filter((call) => call.method === "messages").length, 1)
})

test("transcript pending chunk blocks a second fetch", async () => {
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => ({
      data: [
        { info: { id: "m1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "hold" }] },
      ],
      response: headerResponse("x-next-cursor", null),
    }),
  })
  const tools = createHistoricalTools(services)
  const first = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(first.status, "ok")
  const second = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(second.status, "conflict")
  assert.equal(second.reason, "queue: chunk pending delivery")
  assert.equal(calls.filter((call) => call.method === "messages").length, 1)
})

test("transcript chunk survives the host abort after a successful tool return", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => ({
      data: [
        { info: { id: "m1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: TRANSCRIPT_SENTINEL }] },
      ],
      response: headerResponse("x-next-cursor", "cur-1"),
    }),
  })
  const tools = createHistoricalTools(services)
  const controller = new AbortController()
  const result = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context("ses_caller", controller))
  assert.equal(result.status, "ok")
  assert.equal(result.cursor, "cur-1")
  // OpenCode 1.18.35 aborts the per-tool signal after every successful return.
  controller.abort()
  const delivered = services.queue.take("ses_caller", 0)
  assert.notEqual(delivered, null, "the committed chunk survives the host's post-success abort")
  assert.equal(delivered?.requestMessageID, "msg_tool")
  assert.equal(services.queue.take("ses_caller", 0), null, "delivery is still one-shot")
})

test("transcript cursor continuation works after the completed tool signal abort", async () => {
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async (options: any) =>
      options.query.before === "cur-1"
        ? {
            data: [
              { info: { id: "m0", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "older page" }] },
            ],
            response: headerResponse("x-next-cursor", null),
          }
        : {
            data: [
              { info: { id: "m1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "newest page" }] },
            ],
            response: headerResponse("x-next-cursor", "cur-1"),
          },
  })
  const tools = createHistoricalTools(services)
  const completed = new AbortController()
  const first = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context("ses_caller", completed))
  assert.equal(first.status, "ok")
  assert.equal(first.cursor, "cur-1")
  completed.abort()
  assert.notEqual(services.queue.take("ses_caller", 0), null, "the first chunk is delivered by the transform")

  const second = await execute(
    tools,
    "stm_history_transcript",
    { sessionID: "ses_target", cursor: "cur-1" },
    context("ses_caller"),
  )
  assert.equal(second.status, "ok", `continuation must survive the completed tool signal abort: ${second.reason ?? ""}`)
  assert.equal(second.complete, true)
  assert.equal(calls.some((call) => call.method === "messages" && call.options.query.before === "cur-1"), true)
})

test("abort before and during a deferred fetch never queues text", async () => {
  let releasePage: (value: unknown) => void = () => {}
  const deferred = new Promise((resolve) => {
    releasePage = resolve
  })
  const { services } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => deferred as any,
  })
  const tools = createHistoricalTools(services)

  const before = new AbortController()
  before.abort()
  const beforeResult = await execute(
    tools,
    "stm_history_transcript",
    { sessionID: "ses_target" },
    context("ses_caller", before),
  )
  assert.equal(beforeResult.status, "aborted")
  assert.equal(services.queue.size(), 0, "abort before begin creates no caller state")

  const during = new AbortController()
  const call = execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context("ses_caller", during))
  await new Promise((resolve) => setImmediate(resolve))
  during.abort()
  releasePage({
    data: [{ info: { id: "m1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "late" }] }],
    response: headerResponse("x-next-cursor", null),
  })
  const result = await call
  assert.equal(result.status, "aborted")
  assert.equal(services.queue.take("ses_caller", 0), null, "no chunk was queued after the abort")
})

test("self-target rejected for rename, transcript and review end", async () => {
  const { services, calls } = makeServices(
    historicalConfig({ readTitles: true, renameTitles: true, readTranscript: true }),
  )
  const tools = createHistoricalTools(services)
  const ctx = context()
  const rename = await execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_caller", expectedTitle: "x", title: "y" },
    ctx,
  )
  assert.equal(rename.status, "invalid")
  assert.equal(rename.reason, "self-target")
  const transcript = await execute(tools, "stm_history_transcript", { sessionID: "ses_caller" }, ctx)
  assert.equal(transcript.status, "invalid")
  assert.equal(transcript.reason, "self-target")
  const end = await execute(tools, "stm_history_review_end", { sessionID: "ses_caller", outcome: "reviewed" }, ctx)
  assert.equal(end.status, "invalid")
  assert.equal(end.reason, "self-target")
  assert.equal(ctx.asks.length, 0)
  assert.equal(calls.length, 0)
})

test("review end releases buffers; sensitive blocks transcript and rename", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true, renameTitles: true }))
  const tools = createHistoricalTools(services)
  const ctx = context()
  const seeded = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, ctx)
  assert.equal(seeded.status, "ok")
  const end = await execute(tools, "stm_history_review_end", { sessionID: "ses_target", outcome: "sensitive" }, ctx)
  assert.equal(end.status, "ok")
  assert.equal(services.queue.has(ctx.sessionID), false)

  const blockedTranscript = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(blockedTranscript.status, "conflict")
  assert.equal(blockedTranscript.reason, "sensitive-blocked")
  const blockedRename = await execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_target", expectedTitle: "Historical title", title: "Nope" },
    context(),
  )
  assert.equal(blockedRename.status, "conflict")
  assert.equal(blockedRename.reason, "sensitive-blocked")
})

test("review end asks permission; denied or aborted ends nothing", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => ({
      data: [{ info: { id: "m1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "chunk" }] }],
      response: headerResponse("x-next-cursor", null),
    }),
  })
  const tools = createHistoricalTools(services)
  const seeded = context()
  const seededResult = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, seeded)
  assert.equal(seededResult.status, "ok")
  assert.equal(services.queue.has("ses_caller"), true)

  const denied = context()
  denied.ask = async (input: any) => {
    denied.asks.push(input)
    throw new Error("denied")
  }
  const deniedEnd = await execute(
    tools,
    "stm_history_review_end",
    { sessionID: "ses_target", outcome: "reviewed" },
    denied,
  )
  assert.equal(deniedEnd.status, "denied")
  assert.deepEqual(denied.asks[0], {
    permission: "stm_history_review_end",
    patterns: ["ses_target"],
    always: [],
    metadata: { outcome: "reviewed" },
  })
  assert.equal(services.queue.has("ses_caller"), true)

  const controller = new AbortController()
  controller.abort()
  const abortedEnd = await execute(
    tools,
    "stm_history_review_end",
    { sessionID: "ses_target", outcome: "reviewed" },
    context("ses_caller", controller),
  )
  assert.equal(abortedEnd.status, "aborted")
  assert.equal(services.queue.has("ses_caller"), true)
})

test("review end reviewed and cancelled unblock nothing", async () => {
  for (const outcome of ["reviewed", "cancelled"] as const) {
    const { services } = makeServices(historicalConfig({ readTranscript: true }), {
      messages: async () => ({
        data: [{ info: { id: "m1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "chunk" }] }],
        response: headerResponse("x-next-cursor", null),
      }),
    })
    const tools = createHistoricalTools(services)
    const ctx = context()
    const seeded = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, ctx)
    assert.equal(seeded.status, "ok")
    const end = await execute(tools, "stm_history_review_end", { sessionID: "ses_target", outcome }, ctx)
    assert.equal(end.status, "ok")
    assert.equal(services.queue.has(ctx.sessionID), false)
    assert.equal(services.blocked.get(ctx.sessionID)?.has("ses_target") ?? false, false)
    const again = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
    assert.equal(again.status, "ok", `${outcome} must not block the target`)
  }
})

test("sensitive blocks are bound to the caller-target pair and spare title reads", async () => {
  let title = "Historical title"
  const { services, calls } = makeServices(
    historicalConfig({ readTitles: true, renameTitles: true, readTranscript: true }),
    {
      get: async (options: any) => ({ data: { id: options.path.id, title } }),
      update: async (options: any) => {
        title = String(options.body.title)
        return { data: { id: options.path.id, title } }
      },
    },
  )
  const tools = createHistoricalTools(services)
  const callerA = context("ses_a")
  const seeded = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, callerA)
  assert.equal(seeded.status, "ok")
  const end = await execute(tools, "stm_history_review_end", { sessionID: "ses_target", outcome: "sensitive" }, callerA)
  assert.equal(end.status, "ok")

  // Title reads remain available, and another caller is not blocked for the same target.
  const read = await execute(tools, "stm_history_title_read", { sessionID: "ses_target" }, callerA)
  assert.equal(read.status, "ok")
  const otherCaller = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context("ses_b"))
  assert.equal(otherCaller.status, "ok")

  const blocked = await execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_target", expectedTitle: "Historical title", title: "Nope" },
    context("ses_a"),
  )
  assert.equal(blocked.status, "conflict")
  assert.equal(blocked.reason, "sensitive-blocked")

  const elsewhere = await execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_other", expectedTitle: "Historical title", title: "Allowed" },
    context("ses_a"),
  )
  assert.equal(elsewhere.status, "ok")
  assert.equal(calls.filter((call) => call.method === "update").length, 1)
})

test("sensitive block landing during the rename ask stops the write", async () => {
  let releaseAsk: () => void = () => {}
  const askGate = new Promise<void>((resolve) => {
    releaseAsk = resolve
  })
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true, renameTitles: true }))
  const tools = createHistoricalTools(services)
  const renameCtx = context()
  renameCtx.ask = async () => {
    await askGate
  }
  const call = execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_target", expectedTitle: "Historical title", title: "Nope" },
    renameCtx,
  )
  await flush()
  const end = await execute(tools, "stm_history_review_end", { sessionID: "ses_target", outcome: "sensitive" }, context())
  assert.equal(end.status, "ok")
  releaseAsk()
  const result = await call
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "sensitive-blocked")
  assert.equal(calls.filter((entry) => entry.method === "update").length, 0)
})

test("sensitive block landing during the in-guard target read stops the write", async () => {
  let gated = true
  let releaseRead: () => void = () => {}
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true, renameTitles: true }), {
    get: async (options: any) => {
      if (options.path.id === "ses_target" && gated) {
        gated = false
        await readGate
      }
      return { data: { id: options.path.id, title: "Historical title" } }
    },
  })
  const tools = createHistoricalTools(services)
  const call = execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_target", expectedTitle: "Historical title", title: "Nope" },
    context(),
  )
  await flush()
  const end = await execute(tools, "stm_history_review_end", { sessionID: "ses_target", outcome: "sensitive" }, context())
  assert.equal(end.status, "ok")
  releaseRead()
  const result = await call
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "sensitive-blocked")
  assert.equal(calls.filter((entry) => entry.method === "update").length, 0)
})

test("sensitive block landing during the transcript ask stops the fetch", async () => {
  let releaseAsk: () => void = () => {}
  const askGate = new Promise<void>((resolve) => {
    releaseAsk = resolve
  })
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true, renameTitles: true }))
  const tools = createHistoricalTools(services)
  const transcriptCtx = context()
  transcriptCtx.ask = async () => {
    await askGate
  }
  const call = execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, transcriptCtx)
  await flush()
  const end = await execute(tools, "stm_history_review_end", { sessionID: "ses_target", outcome: "sensitive" }, context())
  assert.equal(end.status, "ok")
  releaseAsk()
  const result = await call
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "sensitive-blocked")
  assert.equal(calls.filter((entry) => entry.method === "messages").length, 0)
  assert.equal(services.queue.has("ses_caller"), false)
})

test("sensitive block landing during the fetch discards the text", async () => {
  let releasePage: (value: unknown) => void = () => {}
  const deferred = new Promise((resolve) => {
    releasePage = resolve
  })
  const { services } = makeServices(historicalConfig({ readTranscript: true, renameTitles: true }), {
    messages: async () => deferred as any,
  })
  const tools = createHistoricalTools(services)
  const call = execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  await flush()
  assert.equal(services.queue.has("ses_caller"), true, "the fetch created the caller binding")
  const end = await execute(tools, "stm_history_review_end", { sessionID: "ses_target", outcome: "sensitive" }, context())
  assert.equal(end.status, "ok")
  assert.equal(services.queue.has("ses_caller"), false)
  releasePage({
    data: [{ info: { id: "m1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "late" }] }],
    response: headerResponse("x-next-cursor", null),
  })
  const result = await call
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "sensitive-blocked")
  assert.equal(services.queue.take("ses_caller", 0), null, "no text was queued after the sensitive stop")
  assert.equal(services.queue.has("ses_caller"), false)
})

test("history rename aborted during the write is uncertain without read-back or lock", async () => {
  let title = "Historical title"
  let releaseUpdate: () => void = () => {}
  const updateGate = new Promise<void>((resolve) => {
    releaseUpdate = resolve
  })
  const { services, calls, dir } = makeServices(historicalConfig({ renameTitles: true }), {
    get: async (options: any) => ({ data: { id: options.path.id, title } }),
    update: async (options: any) => {
      await updateGate
      title = String(options.body.title)
      return { data: { id: options.path.id, title } }
    },
  })
  const tools = createHistoricalTools(services)
  const controller = new AbortController()
  const call = execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_target", expectedTitle: "Historical title", title: "Approved title" },
    context("ses_caller", controller),
  )
  await flush()
  controller.abort()
  releaseUpdate()
  const result = await call
  assert.equal(result.status, "uncertain")
  assert.equal(result.reason, "aborted-during-write")
  assert.equal(calls.filter((entry) => entry.method === "update").length, 1)
  assert.equal(calls[calls.length - 1]?.method, "update", "no read-back after the observed abort")
  assert.equal(existsSync(targetStatePath(dir, "ses_target")), false, "no lock without verification")
})

test("history rename aborted during the read-back is uncertain without lock", async () => {
  let title = "Historical title"
  let readBack = false
  let releaseRead: () => void = () => {}
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  const { services, calls, dir } = makeServices(historicalConfig({ renameTitles: true }), {
    get: async (options: any) => {
      if (readBack) {
        readBack = false
        await readGate
      }
      return { data: { id: options.path.id, title } }
    },
    update: async (options: any) => {
      title = String(options.body.title)
      readBack = true
      return { data: { id: options.path.id, title } }
    },
  })
  const tools = createHistoricalTools(services)
  const controller = new AbortController()
  const call = execute(
    tools,
    "stm_history_title_rename",
    { sessionID: "ses_target", expectedTitle: "Historical title", title: "Approved title" },
    context("ses_caller", controller),
  )
  await flush()
  controller.abort()
  releaseRead()
  const result = await call
  assert.equal(result.status, "uncertain")
  assert.equal(result.reason, "aborted-during-write")
  assert.equal(calls.filter((entry) => entry.method === "update").length, 1)
  assert.equal(calls[calls.length - 1]?.method, "get", "the read-back was the last SDK call")
  assert.equal(existsSync(targetStatePath(dir, "ses_target")), false, "no lock without verification")
})

test("review end rejects a different target without discarding or blocking", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => ({
      data: [{ info: { id: "m1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "chunk" }] }],
      response: headerResponse("x-next-cursor", null),
    }),
  })
  const tools = createHistoricalTools(services)
  const seeded = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(seeded.status, "ok")
  assert.equal(services.queue.has("ses_caller"), true)

  const mismatch = await execute(
    tools,
    "stm_history_review_end",
    { sessionID: "ses_other", outcome: "sensitive" },
    context(),
  )
  assert.equal(mismatch.status, "conflict")
  assert.match(mismatch.reason, /review target mismatch/)
  assert.equal(services.queue.has("ses_caller"), true, "the active review survives a mismatched end")
  assert.equal(services.blocked.get("ses_caller")?.has("ses_other") ?? false, false)

  const matching = await execute(
    tools,
    "stm_history_review_end",
    { sessionID: "ses_target", outcome: "sensitive" },
    context(),
  )
  assert.equal(matching.status, "ok")
  assert.equal(services.queue.has("ses_caller"), false)
  const blocked = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(blocked.status, "conflict")
  assert.equal(blocked.reason, "sensitive-blocked")
})

test("review end with no active review succeeds and binds a sensitive block", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }))
  const tools = createHistoricalTools(services)
  const end = await execute(
    tools,
    "stm_history_review_end",
    { sessionID: "ses_target", outcome: "sensitive" },
    context(),
  )
  assert.equal(end.status, "ok")
  const blocked = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(blocked.status, "conflict")
  assert.equal(blocked.reason, "sensitive-blocked")
})

test("review end recovers a binding lost to abort and still blocks", async () => {
  let releasePage: (value: unknown) => void = () => {}
  const deferred = new Promise((resolve) => {
    releasePage = resolve
  })
  const { services } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => deferred as any,
  })
  const tools = createHistoricalTools(services)
  const controller = new AbortController()
  const call = execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context("ses_caller", controller))
  await flush()
  controller.abort()
  releasePage({ data: [], response: headerResponse("x-next-cursor", null) })
  const aborted = await call
  assert.equal(aborted.status, "aborted")
  assert.equal(services.queue.has("ses_caller"), false)

  const end = await execute(
    tools,
    "stm_history_review_end",
    { sessionID: "ses_target", outcome: "sensitive" },
    context(),
  )
  assert.equal(end.status, "ok")
  const blocked = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(blocked.status, "conflict")
  assert.equal(blocked.reason, "sensitive-blocked")
})
