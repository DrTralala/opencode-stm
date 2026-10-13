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
import { createTranscriptPager, ENVELOPE_BUDGET_REASON } from "../src/transcript.js"
import { createHistoricalTools, type StmServices } from "../src/tools.js"
import { fakeClient, headerResponse, type FakeHandler } from "./fakes.js"

const TRANSCRIPT_SENTINEL = "STM_TRANSCRIPT_SENTINEL_4321"
const BEGIN_MARKER = "----- BEGIN OPENCODE-STM HISTORICAL TRANSCRIPT (UNTRUSTED) -----"
const END_MARKER = "----- END OPENCODE-STM HISTORICAL TRANSCRIPT (UNTRUSTED) -----"

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
    transcripts: createTranscriptPager(),
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

async function executeRaw(tools: Record<string, any>, name: string, args: unknown, ctx: ToolContext): Promise<string> {
  return String(await tools[name]!.execute(args as any, ctx))
}

function headerOf(output: string): Record<string, any> {
  const first = output.split("\n")[0]
  assert.ok(first !== undefined && first.length > 0, "output has a header line")
  return JSON.parse(first)
}

type Fragment = {
  role: "user" | "assistant"
  messageID: string
  partIndex: number
  offsetBytes: number
  partComplete: boolean
  text: string
}

// Parse each payload line independently as one complete JSON record.
function fragmentsOf(output: string): Fragment[] {
  const lines = output.split("\n")
  const begin = lines.indexOf(BEGIN_MARKER)
  const end = lines.lastIndexOf(END_MARKER)
  assert.ok(begin >= 0 && end > begin, "output carries one well-formed frame")
  const raw = lines.slice(begin + 5, end)
  if (raw.length === 1 && raw[0] === "") return []
  return raw.map((line) => JSON.parse(line) as Fragment)
}

// The exact source slice of an output that carries exactly one record.
function soleText(output: string): string {
  const fragments = fragmentsOf(output)
  assert.equal(fragments.length, 1, "expected exactly one record")
  return fragments[0]!.text
}

// Reassemble text by message identity and original part index across outputs.
function reassembled(outputs: string[]): Map<string, string> {
  const state = new Map<string, string>()
  for (const output of outputs) {
    for (const fragment of fragmentsOf(output)) {
      const key = `${fragment.messageID}\u0000${fragment.partIndex}`
      state.set(key, (state.get(key) ?? "") + fragment.text)
    }
  }
  return state
}

function assertBounded(output: string): void {
  assert.ok(Buffer.byteLength(output, "utf8") <= 16 * 1024)
  assert.ok(output.split("\n").length <= 1999)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

const sentinelPage = (nextCursor: string | null, text = TRANSCRIPT_SENTINEL) => ({
  data: [{ info: { id: "m1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text }] }],
  response: headerResponse("x-next-cursor", nextCursor),
})

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

test("transcript returns the framed text directly within both caps", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => sentinelPage(null),
  })
  const tools = createHistoricalTools(services)
  const output = String(await tools.stm_history_transcript!.execute({ sessionID: "ses_target" }, context()))
  assert.ok(output.includes(TRANSCRIPT_SENTINEL))
  assert.ok(Buffer.byteLength(output, "utf8") <= 16 * 1024)
  assert.ok(output.split("\n").length <= 1999)
  const header = JSON.parse(output.split("\n")[0]!)
  assert.equal(header.status, "ok")
  assert.equal(header.sessionID, "ses_target")
  assert.equal(header.complete, true)
  assert.equal(header.cursor, null)
  assert.equal("chunkID" in header, false)
  assert.equal(header.format, "jsonl")
  assert.deepEqual(fragmentsOf(output), [
    { role: "user", messageID: "m1", partIndex: 0, offsetBytes: 0, partComplete: true, text: TRANSCRIPT_SENTINEL },
  ])
  assert.equal(output.split("\n")[1], "")
  assert.equal(output.split("\n")[2], BEGIN_MARKER)
})

test("a user message with summary metadata is delivered with its role and identity", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => ({
      data: [
        {
          info: { id: "u1", sessionID: "ses_target", role: "user", summary: { diffs: [] } },
          parts: [{ id: "p1", type: "text", text: "please fix this" }],
        },
      ],
      response: headerResponse("x-next-cursor", null),
    }),
  })
  const tools = createHistoricalTools(services)
  const output = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  const header = headerOf(output)
  assert.equal(header.complete, true)
  assert.equal(header.messages, 1)
  assert.equal(header.bytes, Buffer.byteLength("please fix this", "utf8"))
  assert.deepEqual(fragmentsOf(output), [
    { role: "user", messageID: "u1", partIndex: 0, offsetBytes: 0, partComplete: true, text: "please fix this" },
  ])
})

test("tool-level consecutive users and an interrupted assistant response stay attributed", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => ({
      data: [
        { info: { id: "u1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "first" }] },
        {
          info: { id: "u2", sessionID: "ses_target", role: "user", summary: { title: "t" } },
          parts: [{ type: "text", text: "second" }],
        },
        {
          info: { id: "a1", sessionID: "ses_target", role: "assistant" },
          parts: [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "partial saved answer" },
          ],
        },
      ],
      response: headerResponse("x-next-cursor", null),
    }),
  })
  const tools = createHistoricalTools(services)
  const output = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  const header = headerOf(output)
  assert.equal(header.complete, true)
  assert.equal(header.messages, 3)
  assert.deepEqual(
    fragmentsOf(output).map((fragment) => [fragment.role, fragment.messageID, fragment.partIndex, fragment.text]),
    [
      ["user", "u1", 0, "first"],
      ["user", "u2", 0, "second"],
      ["assistant", "a1", 1, "partial saved answer"],
    ],
  )
})

test("assistant summary true is excluded at tool level while summary false is kept", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => ({
      data: [
        { info: { id: "u1", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "question" }] },
        {
          info: { id: "s1", sessionID: "ses_target", role: "assistant", summary: true },
          parts: [{ type: "text", text: "generated summary" }],
        },
        {
          info: { id: "a1", sessionID: "ses_target", role: "assistant", summary: false },
          parts: [{ type: "text", text: "real reply" }],
        },
      ],
      response: headerResponse("x-next-cursor", null),
    }),
  })
  const tools = createHistoricalTools(services)
  const output = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.deepEqual(
    fragmentsOf(output).map((fragment) => [fragment.messageID, fragment.text]),
    [
      ["u1", "question"],
      ["a1", "real reply"],
    ],
  )
  assert.equal(output.includes("generated summary"), false)
})

test("transcript metadata carries counts, cursors and guidance but never text", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => sentinelPage("cur-1"),
  })
  const tools = createHistoricalTools(services)
  const ctx = context()
  const output = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, ctx)
  const header = headerOf(output)
  assert.deepEqual(Object.keys(header).sort(), [
    "bytes",
    "complete",
    "continuation",
    "cursor",
    "format",
    "messages",
    "more",
    "page",
    "plugin",
    "sessionID",
    "status",
  ])
  assert.equal(header.bytes > 0, true)
  assert.equal(header.messages, 1)
  assert.equal(header.cursor, "cur-1")
  assert.equal(header.complete, false)
  assert.equal(header.more, true)
  assert.match(header.continuation, /cursor/i)
  assert.equal(JSON.stringify(header).includes(TRANSCRIPT_SENTINEL), false)
  assertBounded(output)
  assert.deepEqual(ctx.asks[0].metadata, {})
})

test("transcript pages deliver distinct continuations and stop when complete", async () => {
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async (options: any) =>
      options.query.before === "cur-1"
        ? {
            data: [{ info: { id: "m0", sessionID: "ses_target", role: "assistant" }, parts: [{ type: "text", text: "older page" }] }],
            response: headerResponse("x-next-cursor", null),
          }
        : sentinelPage("cur-1", "newest page"),
  })
  const tools = createHistoricalTools(services)
  const first = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  const firstHeader = headerOf(first)
  assert.equal(firstHeader.cursor, "cur-1")
  assert.equal(firstHeader.complete, false)
  assert.equal(soleText(first), "newest page")

  const second = await executeRaw(
    tools,
    "stm_history_transcript",
    { sessionID: "ses_target", cursor: "cur-1" },
    context(),
  )
  const secondHeader = headerOf(second)
  assert.equal(secondHeader.complete, true)
  assert.equal(secondHeader.page, 2)
  assert.equal(soleText(second), "older page")
  assert.notEqual(soleText(first), soleText(second), "distinct continuations")

  const stopped = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(stopped.status, "conflict")
  assert.match(stopped.reason, /end of history/)
  assert.equal(calls.filter((call) => call.method === "messages").length, 2)
})

test("transcript direct results stay bounded across same-page continuations", async () => {
  const source = "a".repeat(40000)
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => sentinelPage(null, source),
  })
  const tools = createHistoricalTools(services)
  const outputs: string[] = []
  let cursor: string | undefined
  for (let index = 0; index < 10; index += 1) {
    const args = cursor === undefined ? { sessionID: "ses_target" } : { sessionID: "ses_target", cursor }
    const output = await executeRaw(tools, "stm_history_transcript", args, context())
    assertBounded(output)
    const header = headerOf(output)
    outputs.push(output)
    if (header.complete) break
    cursor = header.cursor ?? undefined
  }
  assert.ok(outputs.length >= 3, "40000 bytes need several bounded chunks")
  assert.equal(reassembled(outputs).get("m1\u00000"), source)
  assert.equal(calls.filter((call) => call.method === "messages").length, outputs.length)
})

test("the transcript description conveys direct persistent results", () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }))
  const tools = createHistoricalTools(services)
  const description = String(tools.stm_history_transcript?.description ?? "")
  assert.match(description, /directly|direct/i)
  assert.match(description, /persist/i)
  assert.match(description, /16 KiB/)
  assert.match(description, /1999/)
  assert.match(description, /cursor/i)
  assert.match(description, /stop|complete/i)
  assert.match(description, /reasoning|tool bodies/i)
  assert.doesNotMatch(description, /queue acknowledgement|later outgoing request/i)
})

test("the review end description does not claim stored results are erased", () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }))
  const tools = createHistoricalTools(services)
  const description = String(tools.stm_history_review_end?.description ?? "")
  assert.match(description, /previously returned|not erased|remain/i)
  assert.doesNotMatch(description, /discard queued|queue acknowledgement/i)
})

test("transcript asks with empty metadata", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => sentinelPage(null),
  })
  const tools = createHistoricalTools(services)
  const ctx = context()
  const result = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, ctx)
  assert.equal(headerOf(result).status, "ok")
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

test("transcript cursor mismatch is a conflict without a refetch", async () => {
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => sentinelPage("cur-1", "partial"),
  })
  const tools = createHistoricalTools(services)
  const first = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(headerOf(first).cursor, "cur-1")
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

test("a failed next-page read retries with the cursor returned by the last result", async () => {
  let pageTwoAttempts = 0
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async (options: any) => {
      if (options.query.before === "cur-1") {
        pageTwoAttempts += 1
        if (pageTwoAttempts === 1) return { error: { message: "unavailable" } }
        return {
          data: [{ info: { id: "m0", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "older page" }] }],
          response: headerResponse("x-next-cursor", null),
        }
      }
      return sentinelPage("cur-1", "newest page")
    },
  })
  const tools = createHistoricalTools(services)
  const first = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  const cursor = headerOf(first).cursor
  assert.equal(cursor, "cur-1")

  const failed = await execute(tools, "stm_history_transcript", { sessionID: "ses_target", cursor }, context())
  assert.equal(failed.status, "error")

  // The exact cursor from the last successful result retries the same page and
  // the page number advances exactly once.
  const second = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target", cursor }, context())
  const secondHeader = headerOf(second)
  assert.equal(secondHeader.status, "ok")
  assert.equal(secondHeader.page, 2)
  assert.equal(secondHeader.complete, true)
  assert.equal(secondHeader.cursor, null)
  assert.equal(soleText(second), "older page")
  assert.equal(pageTwoAttempts, 2)
  assert.equal(calls.filter((call) => call.method === "messages").length, 3)
})

test("an overlapping transcript fetch conflicts instead of racing offsets", async () => {
  let releasePage: (value: unknown) => void = () => {}
  const deferred = new Promise((resolve) => {
    releasePage = resolve
  })
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => deferred as any,
  })
  const tools = createHistoricalTools(services)
  const first = executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  await flush()
  const second = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(second.status, "conflict")
  assert.match(second.reason, /fetch in progress/)
  releasePage(sentinelPage(null))
  const output = await first
  assert.equal(headerOf(output).status, "ok")
  assert.equal(soleText(output), TRANSCRIPT_SENTINEL)
  assert.equal(calls.filter((call) => call.method === "messages").length, 1)
})

test("a failed page read releases the fetch and the retry succeeds", async () => {
  let attempts = 0
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => {
      attempts += 1
      if (attempts === 1) return { error: { message: "unavailable" } }
      return sentinelPage(null)
    },
  })
  const tools = createHistoricalTools(services)
  const failed = await execute(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(failed.status, "error")
  assert.equal(services.transcripts.has("ses_caller"), true, "the binding is retained for a retry")
  const retried = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(headerOf(retried).complete, true)
  assert.equal(soleText(retried), TRANSCRIPT_SENTINEL)
  assert.equal(attempts, 2)
  assert.equal(calls.filter((call) => call.method === "messages").length, 2)
})

test("a malformed page releases the fetch instead of wedging the binding", async () => {
  let attempts = 0
  const { services } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => {
      attempts += 1
      if (attempts === 1) return { data: [null], response: headerResponse("x-next-cursor", null) }
      return sentinelPage(null)
    },
  })
  const tools = createHistoricalTools(services)
  await assert.rejects(executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context()))
  // The failed fetch was released: the next call fetches again instead of
  // conflicting with an abandoned in-flight binding.
  const retried = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(headerOf(retried).complete, true)
  assert.equal(soleText(retried), TRANSCRIPT_SENTINEL)
  assert.equal(attempts, 2)
})

test("abort before and during a deferred fetch leaves no binding and no text", async () => {
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
  assert.equal(services.transcripts.size(), 0, "abort before begin creates no caller state")

  const during = new AbortController()
  const call = executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context("ses_caller", during))
  await flush()
  assert.equal(services.transcripts.has("ses_caller"), true, "the fetch owns the binding")
  during.abort()
  assert.equal(services.transcripts.has("ses_caller"), false, "an in-flight abort invalidates the binding")
  releasePage(sentinelPage(null, "late"))
  const after = JSON.parse(await call)
  assert.equal(after.status, "aborted")
  assert.equal(services.transcripts.has("ses_caller"), false)
})

test("transcript continuation survives the completed tool signal abort", async () => {
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async (options: any) =>
      options.query.before === "cur-1"
        ? {
            data: [{ info: { id: "m0", sessionID: "ses_target", role: "user" }, parts: [{ type: "text", text: "older page" }] }],
            response: headerResponse("x-next-cursor", null),
          }
        : sentinelPage("cur-1", "newest page"),
  })
  const tools = createHistoricalTools(services)
  const completed = new AbortController()
  const first = await executeRaw(
    tools,
    "stm_history_transcript",
    { sessionID: "ses_target" },
    context("ses_caller", completed),
  )
  assert.equal(headerOf(first).cursor, "cur-1")
  // OpenCode 1.18.35 aborts the per-tool signal after every successful return.
  completed.abort()
  assert.equal(services.transcripts.has("ses_caller"), true, "the committed binding survives the host abort")

  const second = await executeRaw(
    tools,
    "stm_history_transcript",
    { sessionID: "ses_target", cursor: "cur-1" },
    context("ses_caller"),
  )
  assert.equal(headerOf(second).complete, true)
  assert.equal(soleText(second), "older page")
  assert.equal(calls.some((call) => call.method === "messages" && call.options.query.before === "cur-1"), true)
})

test("an unrenderable metadata envelope returns a constant bounded error", async () => {
  const huge = `ses_${"t".repeat(20000)}`
  const { services, calls } = makeServices(historicalConfig({ readTranscript: true }), {
    messages: async () => ({ data: [], response: headerResponse("x-next-cursor", null) }),
  })
  const tools = createHistoricalTools(services)
  const failed = await execute(tools, "stm_history_transcript", { sessionID: huge }, context())
  assert.equal(failed.status, "error")
  assert.equal(failed.reason, ENVELOPE_BUDGET_REASON)
  assert.ok(String(failed.reason).length < 200, "the refusal is constant and bounded")

  // The refusal released the fetch: a retry is not blocked and stays deterministic.
  const retry = await execute(tools, "stm_history_transcript", { sessionID: huge }, context())
  assert.equal(retry.status, "error")
  assert.equal(retry.reason, ENVELOPE_BUDGET_REASON)
  assert.equal(calls.filter((call) => call.method === "messages").length, 2)
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

test("review end releases pagination state; sensitive blocks transcript and rename", async () => {
  const { services } = makeServices(historicalConfig({ readTranscript: true, renameTitles: true }), {
    messages: async () => sentinelPage(null),
  })
  const tools = createHistoricalTools(services)
  const ctx = context()
  const seeded = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, ctx)
  assert.equal(headerOf(seeded).status, "ok")
  assert.equal(soleText(seeded), TRANSCRIPT_SENTINEL)
  assert.equal(services.transcripts.has(ctx.sessionID), true, "the completed retrieval keeps its binding")
  const end = await execute(tools, "stm_history_review_end", { sessionID: "ses_target", outcome: "sensitive" }, ctx)
  assert.equal(end.status, "ok")
  assert.equal(services.transcripts.has(ctx.sessionID), false)

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
    messages: async () => sentinelPage(null, "chunk"),
  })
  const tools = createHistoricalTools(services)
  const seeded = context()
  const seededResult = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, seeded)
  assert.equal(headerOf(seededResult).status, "ok")
  assert.equal(services.transcripts.has("ses_caller"), true)

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
  assert.equal(services.transcripts.has("ses_caller"), true)

  const controller = new AbortController()
  controller.abort()
  const abortedEnd = await execute(
    tools,
    "stm_history_review_end",
    { sessionID: "ses_target", outcome: "reviewed" },
    context("ses_caller", controller),
  )
  assert.equal(abortedEnd.status, "aborted")
  assert.equal(services.transcripts.has("ses_caller"), true)
})

test("review end reviewed and cancelled unblock nothing", async () => {
  for (const outcome of ["reviewed", "cancelled"] as const) {
    const { services } = makeServices(historicalConfig({ readTranscript: true }), {
      messages: async () => sentinelPage(null, "chunk"),
    })
    const tools = createHistoricalTools(services)
    const ctx = context()
    // Establish and then complete a binding.
    await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, ctx)
    assert.equal(services.transcripts.has(ctx.sessionID), true)
    const end = await execute(tools, "stm_history_review_end", { sessionID: "ses_target", outcome }, ctx)
    assert.equal(end.status, "ok")
    assert.equal(services.transcripts.has(ctx.sessionID), false)
    assert.equal(services.blocked.get(ctx.sessionID)?.has("ses_target") ?? false, false)
    const again = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
    assert.equal(headerOf(again).status, "ok", `${outcome} must not block the target`)
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
      messages: async () => sentinelPage(null, "chunk"),
    },
  )
  const tools = createHistoricalTools(services)
  const callerA = context("ses_a")
  const seeded = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, callerA)
  assert.equal(headerOf(seeded).status, "ok")
  const end = await execute(tools, "stm_history_review_end", { sessionID: "ses_target", outcome: "sensitive" }, callerA)
  assert.equal(end.status, "ok")

  // Title reads remain available, and another caller is not blocked for the same target.
  const read = await execute(tools, "stm_history_title_read", { sessionID: "ses_target" }, callerA)
  assert.equal(read.status, "ok")
  const otherCaller = await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context("ses_b"))
  assert.equal(headerOf(otherCaller).status, "ok")

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
  assert.equal(services.transcripts.has("ses_caller"), false)
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
  assert.equal(services.transcripts.has("ses_caller"), true, "the fetch created the caller binding")
  const end = await execute(tools, "stm_history_review_end", { sessionID: "ses_target", outcome: "sensitive" }, context())
  assert.equal(end.status, "ok")
  assert.equal(services.transcripts.has("ses_caller"), false)
  releasePage(sentinelPage(null, "late"))
  const result = await call
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "sensitive-blocked")
  assert.equal(services.transcripts.has("ses_caller"), false, "no binding survived the sensitive stop")
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
    messages: async () => sentinelPage("cur-1", "chunk"),
  })
  const tools = createHistoricalTools(services)
  await executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context())
  assert.equal(services.transcripts.has("ses_caller"), true)

  const mismatch = await execute(
    tools,
    "stm_history_review_end",
    { sessionID: "ses_other", outcome: "sensitive" },
    context(),
  )
  assert.equal(mismatch.status, "conflict")
  assert.match(mismatch.reason, /review target mismatch/)
  assert.equal(services.transcripts.has("ses_caller"), true, "the active review survives a mismatched end")
  assert.equal(services.blocked.get("ses_caller")?.has("ses_other") ?? false, false)

  const matching = await execute(
    tools,
    "stm_history_review_end",
    { sessionID: "ses_target", outcome: "sensitive" },
    context(),
  )
  assert.equal(matching.status, "ok")
  assert.equal(services.transcripts.has("ses_caller"), false)
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
  const call = executeRaw(tools, "stm_history_transcript", { sessionID: "ses_target" }, context("ses_caller", controller))
  await flush()
  controller.abort()
  releasePage({ data: [], response: headerResponse("x-next-cursor", null) })
  const aborted = JSON.parse(await call)
  assert.equal(aborted.status, "aborted")
  assert.equal(services.transcripts.has("ses_caller"), false)

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
