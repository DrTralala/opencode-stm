// test/tools-current.test.ts
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG } from "../src/config.js"
import { hashSessionID, hashTitle, initialMeta, createStateStore, createOperationGuard } from "../src/state.js"
import { createRootCache } from "../src/sdk.js"
import { createTranscriptPager } from "../src/transcript.js"
import { resolveReview, unlock } from "../src/scheduler.js"
import { createCurrentTools, establishBaseline, validateTitle, type StmServices } from "../src/tools.js"
import { fakeClient, type FakeHandler } from "./fakes.js"

const DEFAULT_TITLE = "New session - 2026-10-10T00:00:00.000Z"

const createdDirs: string[] = []

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
})

function context(sessionID = "ses_1", abort = new AbortController()): ToolContext & { asks: any[] } {
  const asks: any[] = []
  return {
    sessionID,
    messageID: "msg_1",
    agent: "build",
    directory: "/tmp",
    worktree: "/tmp",
    abort: abort.signal,
    metadata() {},
    ask: async (input: any) => {
      asks.push(input)
    },
    asks,
  } as ToolContext & { asks: any[] }
}

function makeServices(handlers: { get?: FakeHandler; update?: FakeHandler } = {}, parentID?: string) {
  let currentTitle = DEFAULT_TITLE
  const dir = mkdtempSync(join(tmpdir(), "stm-tools-"))
  createdDirs.push(dir)
  const { client, calls } = fakeClient({
    get:
      handlers.get ??
      (async (options: any) => ({
        data: { id: options.path.id, title: currentTitle, ...(parentID === undefined ? {} : { parentID }) },
      })),
    update:
      handlers.update ??
      (async (options: any) => {
        currentTitle = String(options.body.title)
        return { data: { id: options.path.id, title: currentTitle } }
      }),
  })
  const services: StmServices = {
    client,
    config: DEFAULT_CONFIG,
    state: createStateStore({ stateDir: dir }),
    transcripts: createTranscriptPager(),
    roots: createRootCache(client),
    guard: createOperationGuard(),
    blocked: new Map(),
    now: () => 0,
  }
  return { services, calls, dir, setTitle: (value: string) => (currentTitle = value) }
}

function readState(dir: string, sessionID: string) {
  return JSON.parse(readFileSync(join(dir, `${hashSessionID(sessionID)}.json`), "utf8"))
}

async function execute(tools: ReturnType<typeof createCurrentTools>, name: string, args: unknown, ctx: ToolContext) {
  return JSON.parse(String(await tools[name]!.execute(args as any, ctx)))
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("validateTitle trims, counts code points and rejects control characters", () => {
  assert.deepEqual(validateTitle("  hello  "), { ok: true, value: "hello" })
  assert.equal(validateTitle("   ").ok, false)
  assert.equal(validateTitle("a".repeat(121)).ok, false)
  assert.equal(validateTitle("😀".repeat(120)).ok, true)
  assert.equal(validateTitle("two\nlines").ok, false)
  assert.equal(validateTitle("bell\u0007").ok, false)
  assert.equal(validateTitle("nel\u0085").ok, false)
  assert.equal(validateTitle("line\u2028sep").ok, false)
  assert.equal(validateTitle("para\u2029sep").ok, false)
})

test("stm_title_read establishes a baseline and returns bounded status", async () => {
  const { services, dir } = makeServices()
  const tools = createCurrentTools(services)
  const result = await execute(tools, "stm_title_read", {}, context())
  assert.equal(result.status, "ok")
  assert.equal(result.title, DEFAULT_TITLE)
  assert.equal(result.locked, false)
  assert.equal(result.reviewID, null)
  assert.equal(readState(dir, "ses_1").titleDigest, hashTitle(DEFAULT_TITLE))
})

test("keep resolves the review, resets activity and issues no update", async () => {
  const { services, calls, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 42,
    baselineMessageID: "m42",
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const result = await execute(
    tools,
    "stm_title_review",
    { decision: "keep", expectedTitle: DEFAULT_TITLE, reviewID: "rev-1" },
    context(),
  )
  assert.equal(result.status, "ok")
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
  const state = readState(dir, "ses_1")
  assert.equal(state.review, null)
  assert.equal(state.activity, 0)
})

test("rename asks permission, writes once, verifies read-back and clears the review", async () => {
  const { services, calls, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    baselineMessageID: "m20",
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const ctx = context()
  const result = await execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "  Project notes  ", reviewID: "rev-1" },
    ctx,
  )
  assert.equal(result.status, "ok")
  assert.equal(result.title, "Project notes")
  assert.equal(ctx.asks.length, 1)
  assert.deepEqual(
    { permission: ctx.asks[0].permission, patterns: ctx.asks[0].patterns, always: ctx.asks[0].always },
    { permission: "stm_title_review", patterns: ["ses_1"], always: [] },
  )
  assert.equal(typeof ctx.asks[0].metadata.newTitle, "string")
  const updates = calls.filter((call) => call.method === "update")
  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0]?.options.body, { title: "Project notes" })
  const updateIndex = calls.indexOf(updates[0]!)
  assert.equal(calls.slice(updateIndex + 1).some((call) => call.method === "get"), true)
  const state = readState(dir, "ses_1")
  assert.equal(state.review, null)
  assert.equal(state.activity, 0)
  assert.equal(state.titleDigest, hashTitle("Project notes"))
})

test("keep asks permission before clearing the review", async () => {
  const { services, calls, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 42,
    baselineMessageID: "m42",
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const ctx = context()
  const result = await execute(
    tools,
    "stm_title_review",
    { decision: "keep", expectedTitle: DEFAULT_TITLE, reviewID: "rev-1" },
    ctx,
  )
  assert.equal(result.status, "ok")
  assert.equal(ctx.asks.length, 1)
  assert.deepEqual(
    { permission: ctx.asks[0].permission, patterns: ctx.asks[0].patterns, always: ctx.asks[0].always },
    { permission: "stm_title_review", patterns: ["ses_1"], always: [] },
  )
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
  const state = readState(dir, "ses_1")
  assert.equal(state.review, null)
  assert.equal(state.activity, 0)
})

test("denied or aborted keep leaves the review and activity intact", async () => {
  const { services, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 42,
    baselineMessageID: "m42",
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)

  const denied = context()
  denied.ask = async () => {
    throw new Error("denied")
  }
  const deniedResult = await execute(
    tools,
    "stm_title_review",
    { decision: "keep", expectedTitle: DEFAULT_TITLE, reviewID: "rev-1" },
    denied,
  )
  assert.equal(deniedResult.status, "denied")

  const controller = new AbortController()
  controller.abort()
  const abortedResult = await execute(
    tools,
    "stm_title_review",
    { decision: "keep", expectedTitle: DEFAULT_TITLE, reviewID: "rev-1" },
    context("ses_1", controller),
  )
  assert.equal(abortedResult.status, "aborted")

  const state = readState(dir, "ses_1")
  assert.equal(state.review.id, "rev-1")
  assert.equal(state.activity, 42)
})

test("stale review id and expectedTitle mismatch both conflict without clearing", async () => {
  const { services, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const stale = await execute(
    tools,
    "stm_title_review",
    { decision: "keep", expectedTitle: DEFAULT_TITLE, reviewID: "rev-9" },
    context(),
  )
  assert.equal(stale.status, "conflict")
  assert.equal(stale.reason, "stale-review")
  const mismatch = await execute(
    tools,
    "stm_title_review",
    { decision: "keep", expectedTitle: "wrong title", reviewID: "rev-1" },
    context(),
  )
  assert.equal(mismatch.status, "conflict")
  assert.equal(mismatch.reason, "expected-title-mismatch")
  assert.equal(readState(dir, "ses_1").review.id, "rev-1")
})

test("denied permission and pre-aborted calls perform no SDK write", async () => {
  const denied = context()
  const { services, calls } = makeServices()
  let callsAtDeny = -1
  denied.ask = async () => {
    callsAtDeny = calls.length
    throw new Error("denied")
  }
  await services.state.save("ses_1", { ...initialMeta(), titleDigest: hashTitle(DEFAULT_TITLE) })
  const tools = createCurrentTools(services)
  const deniedResult = await execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name" },
    denied,
  )
  assert.equal(deniedResult.status, "denied")
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
  assert.equal(calls.length, callsAtDeny)

  const abortCalls = calls.length
  const controller = new AbortController()
  controller.abort()
  const abortedCtx = context("ses_1", controller)
  const aborted = await execute(tools, "stm_title_review", { decision: "keep", expectedTitle: DEFAULT_TITLE }, abortedCtx)
  assert.equal(aborted.status, "aborted")
  assert.equal(calls.length, abortCalls)
})

test("read-back mismatch is uncertain, keeps the review and never retries", async () => {
  let title = DEFAULT_TITLE
  const { services, calls } = makeServices({
    update: async (options: any) => {
      title = "A different title" // simulates another writer winning
      return { data: { id: options.path.id, title: "New name" } }
    },
    get: async (options: any) => ({ data: { id: options.path.id, title } }),
  })
  await services.state.save("ses_1", { ...initialMeta(), titleDigest: hashTitle(DEFAULT_TITLE) })
  const tools = createCurrentTools(services)
  const result = await execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name" },
    context(),
  )
  assert.equal(result.status, "uncertain")
  assert.equal(calls.filter((call) => call.method === "update").length, 1)
})

test("locked sessions reject rename but still allow keep and read", async () => {
  const { services } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    locked: true,
    lockReason: "manual",
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const rename = await execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name" },
    context(),
  )
  assert.equal(rename.status, "conflict")
  assert.equal(rename.reason, "locked")
  const keep = await execute(tools, "stm_title_review", { decision: "keep", expectedTitle: DEFAULT_TITLE }, context())
  assert.equal(keep.status, "ok")
})

test("non-default first observation locks and child callers are rejected", async () => {
  const locked = makeServices({ get: async (options: any) => ({ data: { id: options.path.id, title: "My notes" } }) })
  const lockedTool = createCurrentTools(locked.services)
  const lockedRead = await execute(lockedTool, "stm_title_read", {}, context())
  assert.equal(lockedRead.status, "ok")
  assert.equal(lockedRead.locked, true)
  assert.equal(lockedRead.lockReason, "non-default-title")

  const child = makeServices({}, "ses_parent")
  const childTools = createCurrentTools(child.services)
  assert.equal((await execute(childTools, "stm_title_read", {}, context())).status, "unsupported-child-session")
})

test("rename without a title is invalid", async () => {
  const { services, calls } = makeServices()
  const tools = createCurrentTools(services)
  const ctx = context()
  const result = await execute(tools, "stm_title_review", { decision: "rename", expectedTitle: DEFAULT_TITLE }, ctx)
  assert.equal(result.status, "invalid")
  assert.equal(result.reason, "title-required")
  assert.equal(ctx.asks.length, 0)
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
})

test("keep with a title is invalid", async () => {
  const { services, calls } = makeServices()
  const tools = createCurrentTools(services)
  const ctx = context()
  const result = await execute(
    tools,
    "stm_title_review",
    { decision: "keep", expectedTitle: DEFAULT_TITLE, title: "x" },
    ctx,
  )
  assert.equal(result.status, "invalid")
  assert.equal(result.reason, "title-not-allowed")
  assert.equal(ctx.asks.length, 0)
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
})

test("121-code-point title is rejected before permission", async () => {
  const { services, calls } = makeServices()
  const tools = createCurrentTools(services)
  const ctx = context()
  const result = await execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "a".repeat(121) },
    ctx,
  )
  assert.equal(result.status, "invalid")
  assert.equal(result.reason, "title-too-long")
  assert.equal(ctx.asks.length, 0)
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
})

test("control characters rejected before permission", async () => {
  const { services, calls } = makeServices()
  const tools = createCurrentTools(services)
  for (const title of ["\u0007x", "\u0085x", "a\u2028b"]) {
    const ctx = context()
    const result = await execute(tools, "stm_title_review", { decision: "rename", expectedTitle: DEFAULT_TITLE, title }, ctx)
    assert.equal(result.status, "invalid")
    assert.equal(result.reason, "title-control-characters")
    assert.equal(ctx.asks.length, 0)
  }
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
})

test("expectedTitle mismatch keeps the review", async () => {
  const { services, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const result = await execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: "wrong title", title: "New name", reviewID: "rev-1" },
    context(),
  )
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "expected-title-mismatch")
  const state = readState(dir, "ses_1")
  assert.equal(state.review.id, "rev-1")
  assert.equal(state.activity, 20)
})

test("external digest mismatch locks and returns locked", async () => {
  const { services, dir, setTitle } = makeServices()
  setTitle("Changed externally")
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const ctx = context()
  const result = await execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: "Changed externally", title: "New name", reviewID: "rev-1" },
    ctx,
  )
  assert.equal(result.status, "locked")
  assert.equal(result.reason, "external-title-change")
  assert.equal(ctx.asks.length, 0)
  const state = readState(dir, "ses_1")
  assert.equal(state.locked, true)
  assert.equal(state.lockReason, "external")
})

test("update .error returns error and keeps the review", async () => {
  const { services, calls, dir } = makeServices({ update: async () => ({ error: { message: "boom" } }) })
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const result = await execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name", reviewID: "rev-1" },
    context(),
  )
  assert.equal(result.status, "error")
  assert.equal(calls.filter((call) => call.method === "update").length, 1)
  const state = readState(dir, "ses_1")
  assert.equal(state.review.id, "rev-1")
  assert.equal(state.activity, 20)
})

test("state-save failure after a verified write is uncertain", async () => {
  // Sabotage the state directory at the moment the SDK write is issued: the
  // in-guard state read still succeeds, so the write is verified first and only
  // the state transition fails.
  let title = DEFAULT_TITLE
  const { services, calls, dir } = makeServices({
    get: async (options: any) => ({ data: { id: options.path.id, title } }),
    update: async (options: any) => {
      title = String(options.body.title)
      rmSync(dir, { recursive: true, force: true })
      writeFileSync(dir, "blocked")
      return { data: { id: options.path.id, title } }
    },
  })
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const result = await execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name", reviewID: "rev-1" },
    context(),
  )
  assert.equal(result.status, "uncertain")
  assert.equal(result.reason, "state-save-failed")
  assert.equal(calls.filter((call) => call.method === "update").length, 1)
})

test("lock writes manual lock and unlock resets activity and digest", async () => {
  const { services, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 42,
    baselineMessageID: "m42",
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const lockCtx = context()
  const locked = await execute(tools, "stm_title_lock", { locked: true, expectedTitle: DEFAULT_TITLE }, lockCtx)
  assert.equal(locked.status, "ok")
  assert.equal(locked.locked, true)
  assert.deepEqual(
    { permission: lockCtx.asks[0].permission, patterns: lockCtx.asks[0].patterns, always: lockCtx.asks[0].always },
    { permission: "stm_title_lock", patterns: ["ses_1"], always: [] },
  )
  const lockedState = readState(dir, "ses_1")
  assert.equal(lockedState.locked, true)
  assert.equal(lockedState.lockReason, "manual")
  assert.equal(lockedState.review.id, "rev-1")

  const unlockCtx = context()
  const unlocked = await execute(tools, "stm_title_lock", { locked: false, expectedTitle: DEFAULT_TITLE }, unlockCtx)
  assert.equal(unlocked.status, "ok")
  assert.equal(unlocked.locked, false)
  const state = readState(dir, "ses_1")
  assert.equal(state.locked, false)
  assert.equal(state.lockReason, "none")
  assert.equal(state.activity, 0)
  assert.equal(state.titleDigest, hashTitle(DEFAULT_TITLE))
  assert.equal(state.review, null)
})

test("lock expectedTitle mismatch conflicts without state change", async () => {
  const { services, calls, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const result = await execute(tools, "stm_title_lock", { locked: true, expectedTitle: "wrong" }, context())
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "expected-title-mismatch")
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
  const state = readState(dir, "ses_1")
  assert.equal(state.locked, false)
  assert.equal(state.review.id, "rev-1")
})

test("title read truncation is flagged beyond 200 code points", async () => {
  const { services, setTitle } = makeServices()
  setTitle("x".repeat(250))
  const tools = createCurrentTools(services)
  const result = await execute(tools, "stm_title_read", {}, context())
  assert.equal(result.status, "ok")
  assert.equal(result.titleTruncated, true)
  assert.equal([...result.title].length, 201)
  assert.equal(result.title.endsWith("…"), true)
  assert.equal(result.locked, true)
  assert.equal(result.lockReason, "non-default-title")
})

test("rename re-reads inside the guard and refuses to write after a concurrent title change", async () => {
  let title = DEFAULT_TITLE
  let reads = 0
  const { services, calls, dir } = makeServices({
    get: async (options: any) => {
      reads += 1
      if (reads === 3) title = "Concurrent change"
      return { data: { id: options.path.id, title } }
    },
  })
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const result = await execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name", reviewID: "rev-1" },
    context(),
  )
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "expected-title-mismatch")
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
  assert.equal(readState(dir, "ses_1").review.id, "rev-1")
})

test("state persistence never stores the raw title", async () => {
  const { services, dir, setTitle } = makeServices()
  setTitle("Secret project codename")
  const tools = createCurrentTools(services)
  const result = await execute(tools, "stm_title_read", {}, context())
  assert.equal(result.status, "ok")
  assert.equal(result.title, "Secret project codename")
  const raw = readFileSync(join(dir, `${hashSessionID("ses_1")}.json`), "utf8")
  assert.equal(raw.includes("Secret project codename"), false)
  assert.equal(JSON.parse(raw).titleDigest, null)
})

test("a manual lock during a pending rename ask blocks the rename write", async () => {
  const { services, calls, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const asked = deferred()
  const release = deferred()
  const ctx = context()
  ctx.ask = async () => {
    asked.resolve()
    await release.promise
  }
  const renamePromise = execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name", reviewID: "rev-1" },
    ctx,
  )
  await asked.promise
  const lock = await execute(tools, "stm_title_lock", { locked: true, expectedTitle: DEFAULT_TITLE }, context())
  assert.equal(lock.status, "ok")
  assert.equal(lock.locked, true)
  release.resolve()
  const result = await renamePromise
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "locked")
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
  const state = readState(dir, "ses_1")
  assert.equal(state.locked, true)
  assert.equal(state.lockReason, "manual")
  assert.equal(state.review.id, "rev-1")
})

test("baseline establishment does not overwrite a concurrent state write", async () => {
  const { services, dir } = makeServices()
  const baselinePromise = establishBaseline(services, "ses_1", undefined, DEFAULT_TITLE)
  const concurrentSave = services.state.save("ses_1", {
    ...initialMeta(),
    locked: true,
    lockReason: "manual",
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const baseline = await baselinePromise
  assert.equal(baseline.ok, true)
  assert.equal((await concurrentSave).ok, true)
  const state = readState(dir, "ses_1")
  assert.equal(state.locked, true)
  assert.equal(state.lockReason, "manual")
  assert.equal(state.titleDigest, hashTitle(DEFAULT_TITLE))
})

test("keep does not erase a lock that lands during a pending ask", async () => {
  const { services, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 42,
    baselineMessageID: "m42",
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const asked = deferred()
  const release = deferred()
  const ctx = context()
  ctx.ask = async () => {
    asked.resolve()
    await release.promise
  }
  const keepPromise = execute(
    tools,
    "stm_title_review",
    { decision: "keep", expectedTitle: DEFAULT_TITLE, reviewID: "rev-1" },
    ctx,
  )
  await asked.promise
  const lock = await execute(tools, "stm_title_lock", { locked: true, expectedTitle: DEFAULT_TITLE }, context())
  assert.equal(lock.status, "ok")
  release.resolve()
  const result = await keepPromise
  assert.equal(result.status, "ok")
  assert.equal(result.decision, "keep")
  const state = readState(dir, "ses_1")
  assert.equal(state.locked, true)
  assert.equal(state.lockReason, "manual")
  assert.equal(state.review, null)
  assert.equal(state.activity, 0)
})

test("keep conflicts when the title changes during a pending ask", async () => {
  const { services, dir, setTitle } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const asked = deferred()
  const release = deferred()
  const ctx = context()
  ctx.ask = async () => {
    asked.resolve()
    await release.promise
  }
  const keepPromise = execute(
    tools,
    "stm_title_review",
    { decision: "keep", expectedTitle: DEFAULT_TITLE, reviewID: "rev-1" },
    ctx,
  )
  await asked.promise
  setTitle("Changed during ask")
  release.resolve()
  const result = await keepPromise
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "expected-title-mismatch")
  const state = readState(dir, "ses_1")
  assert.equal(state.review.id, "rev-1")
  assert.equal(state.activity, 20)
})

test("external digest check does not overwrite a manual lock that landed during the read", async () => {
  let gets = 0
  const readSeen = deferred()
  const readRelease = deferred()
  const { services, dir } = makeServices({
    get: async (options: any) => {
      gets += 1
      if (gets === 2) {
        readSeen.resolve()
        await readRelease.promise
      }
      return { data: { id: options.path.id, title: "Changed externally" } }
    },
  })
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const reviewPromise = execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: "Changed externally", title: "New name", reviewID: "rev-1" },
    context(),
  )
  await readSeen.promise
  const lock = await execute(
    tools,
    "stm_title_lock",
    { locked: true, expectedTitle: "Changed externally" },
    context(),
  )
  assert.equal(lock.status, "ok")
  readRelease.resolve()
  const result = await reviewPromise
  assert.equal(result.status, "locked")
  assert.equal(result.reason, "external-title-change")
  const state = readState(dir, "ses_1")
  assert.equal(state.locked, true)
  assert.equal(state.lockReason, "manual")
})

// Holds a rename inside its guarded section at its pre-write read with the
// title still unchanged, lets a lock call queue on the same guard, then
// releases the rename so it changes the title before the queued lock's own
// guarded title read runs.
async function runLockDuringRename(lockedRequest: boolean) {
  let title = DEFAULT_TITLE
  let gets = 0
  const held = deferred()
  const release = deferred()
  const { services, dir } = makeServices({
    get: async (options: any) => {
      gets += 1
      if (gets === 3) {
        held.resolve()
        await release.promise
      }
      return { data: { id: options.path.id, title } }
    },
    update: async (options: any) => {
      title = String(options.body.title)
      return { data: { id: options.path.id, title } }
    },
  })
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const renamePromise = execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name", reviewID: "rev-1" },
    context(),
  )
  await held.promise
  const lockPromise = execute(
    tools,
    "stm_title_lock",
    { locked: lockedRequest, expectedTitle: DEFAULT_TITLE },
    context(),
  )
  // Flush microtasks so the lock call has queued on the same guard before the
  // rename is allowed to complete; the lock reads the title inside the guard
  // after the rename changed it.
  await new Promise((resolve) => setImmediate(resolve))
  release.resolve()
  const result = await lockPromise
  await renamePromise
  return { result, state: readState(dir, "ses_1") }
}

test("lock queued behind a rename conflicts when the rename changes the title", async () => {
  const { result, state } = await runLockDuringRename(true)
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "expected-title-mismatch")
  assert.equal(state.locked, false)
  assert.equal(state.lockReason, "none")
  assert.equal(state.titleDigest, hashTitle("New name"))
})

test("unlock queued behind a rename conflicts instead of applying the stale digest", async () => {
  const { result, state } = await runLockDuringRename(false)
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "expected-title-mismatch")
  assert.equal(state.locked, false)
  assert.equal(state.titleDigest, hashTitle("New name"))
})

test("abort during the lock title read prevents the state change", async () => {
  let gets = 0
  const readSeen = deferred()
  const readRelease = deferred()
  const { services, dir } = makeServices({
    get: async (options: any) => {
      gets += 1
      if (gets === 2) {
        readSeen.resolve()
        await readRelease.promise
      }
      return { data: { id: options.path.id, title: DEFAULT_TITLE } }
    },
  })
  await services.state.save("ses_1", { ...initialMeta(), titleDigest: hashTitle(DEFAULT_TITLE) })
  const tools = createCurrentTools(services)
  const controller = new AbortController()
  const resultPromise = execute(
    tools,
    "stm_title_lock",
    { locked: true, expectedTitle: DEFAULT_TITLE },
    context("ses_1", controller),
  )
  await readSeen.promise
  controller.abort()
  readRelease.resolve()
  const result = await resultPromise
  assert.equal(result.status, "aborted")
  const state = readState(dir, "ses_1")
  assert.equal(state.locked, false)
})

test("rename aborted during the write is uncertain and keeps the review unresolved", async () => {
  let title = DEFAULT_TITLE
  let releaseUpdate: () => void = () => {}
  const updateGate = new Promise<void>((resolve) => {
    releaseUpdate = resolve
  })
  const { services, calls, dir } = makeServices({
    get: async (options: any) => ({ data: { id: options.path.id, title } }),
    update: async (options: any) => {
      await updateGate
      title = String(options.body.title)
      return { data: { id: options.path.id, title } }
    },
  })
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const controller = new AbortController()
  const call = execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name", reviewID: "rev-1" },
    context("ses_1", controller),
  )
  await flush()
  controller.abort()
  releaseUpdate()
  const result = await call
  assert.equal(result.status, "uncertain")
  assert.equal(result.reason, "aborted-during-write")
  assert.equal(calls.filter((entry) => entry.method === "update").length, 1)
  assert.equal(calls[calls.length - 1]?.method, "update", "no read-back after the observed abort")
  const state = readState(dir, "ses_1")
  assert.equal(state.review?.id, "rev-1")
  assert.equal(state.activity, 20)
})

test("rename aborted during the read-back is uncertain and keeps the review unresolved", async () => {
  let title = DEFAULT_TITLE
  let readBack = false
  let releaseRead: () => void = () => {}
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  const { services, calls, dir } = makeServices({
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
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const controller = new AbortController()
  const call = execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name", reviewID: "rev-1" },
    context("ses_1", controller),
  )
  await flush()
  controller.abort()
  releaseRead()
  const result = await call
  assert.equal(result.status, "uncertain")
  assert.equal(result.reason, "aborted-during-write")
  assert.equal(calls.filter((entry) => entry.method === "update").length, 1)
  assert.equal(calls[calls.length - 1]?.method, "get", "the read-back was the last SDK call")
  const state = readState(dir, "ses_1")
  assert.equal(state.review?.id, "rev-1")
  assert.equal(state.activity, 20)
})

test("rename with a stale review ID conflicts without writing after the review resolves during the ask", async () => {
  const { services, calls, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const asked = deferred()
  const release = deferred()
  const ctx = context()
  ctx.ask = async () => {
    asked.resolve()
    await release.promise
  }
  const renamePromise = execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name", reviewID: "rev-1" },
    ctx,
  )
  await asked.promise
  // A concurrent keep resolves the review while the rename ask is pending.
  const resolved = await services.state.update("ses_1", (current) => ({
    next: resolveReview(current ?? initialMeta(), hashTitle(DEFAULT_TITLE)),
    result: true,
  }))
  assert.equal(resolved.ok, true)
  release.resolve()
  const result = await renamePromise
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "stale-review")
  assert.equal(calls.filter((call) => call.method === "update").length, 0, "the stale rename never wrote")
  const state = readState(dir, "ses_1")
  assert.equal(state.review, null)
  assert.equal(state.titleDigest, hashTitle(DEFAULT_TITLE), "no rename digest landed")
})

test("rename with a stale review ID conflicts without writing after a new review replaces it during the ask", async () => {
  const { services, calls, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const asked = deferred()
  const release = deferred()
  const ctx = context()
  ctx.ask = async () => {
    asked.resolve()
    await release.promise
  }
  const renamePromise = execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name", reviewID: "rev-1" },
    ctx,
  )
  await asked.promise
  // A fresh review identity was created (for example after an unlock) while the
  // rename ask was pending; the caller never saw rev-2.
  const replaced = await services.state.update("ses_1", (current) => ({
    next: { ...(current ?? initialMeta()), review: { id: "rev-2", remindersSent: 1, nextTriggerAt: 60 } },
    result: true,
  }))
  assert.equal(replaced.ok, true)
  release.resolve()
  const result = await renamePromise
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "stale-review")
  assert.equal(calls.filter((call) => call.method === "update").length, 0, "the stale rename never wrote")
  const state = readState(dir, "ses_1")
  assert.equal(state.review.id, "rev-2", "the new review is not cleared by the stale rename")
  assert.equal(state.titleDigest, hashTitle(DEFAULT_TITLE))
})

test("keep with a stale review ID conflicts after the review resolves during the ask", async () => {
  const { services, calls, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 42,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const asked = deferred()
  const release = deferred()
  const ctx = context()
  ctx.ask = async () => {
    asked.resolve()
    await release.promise
  }
  const keepPromise = execute(
    tools,
    "stm_title_review",
    { decision: "keep", expectedTitle: DEFAULT_TITLE, reviewID: "rev-1" },
    ctx,
  )
  await asked.promise
  // A concurrent keep resolves the review while this keep's ask is pending.
  const resolved = await services.state.update("ses_1", (current) => ({
    next: resolveReview(current ?? initialMeta(), hashTitle(DEFAULT_TITLE)),
    result: true,
  }))
  assert.equal(resolved.ok, true)
  release.resolve()
  const result = await keepPromise
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "stale-review")
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
  const state = readState(dir, "ses_1")
  assert.equal(state.review, null)
  // The concurrent keep's own resolution reset the activity; this stale call
  // must not resolve anything further.
  assert.equal(state.activity, 0)
  assert.equal(state.titleDigest, hashTitle(DEFAULT_TITLE))
})

test("keep with a stale review ID conflicts without clearing a replaced review during the ask", async () => {
  const { services, calls, dir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 42,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const tools = createCurrentTools(services)
  const asked = deferred()
  const release = deferred()
  const ctx = context()
  ctx.ask = async () => {
    asked.resolve()
    await release.promise
  }
  const keepPromise = execute(
    tools,
    "stm_title_review",
    { decision: "keep", expectedTitle: DEFAULT_TITLE, reviewID: "rev-1" },
    ctx,
  )
  await asked.promise
  // A fresh review identity replaced the one the caller confirmed.
  const replaced = await services.state.update("ses_1", (current) => ({
    next: { ...(current ?? initialMeta()), review: { id: "rev-2", remindersSent: 1, nextTriggerAt: 60 } },
    result: true,
  }))
  assert.equal(replaced.ok, true)
  release.resolve()
  const result = await keepPromise
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "stale-review")
  assert.equal(calls.filter((call) => call.method === "update").length, 0)
  const state = readState(dir, "ses_1")
  assert.equal(state.review.id, "rev-2", "the replaced review is not resolved by the stale keep")
  assert.equal(state.activity, 42)
})

test("an unlock establishing the current digest during a deferred read prevents the external lock", async () => {
  let gets = 0
  const readSeen = deferred()
  const readRelease = deferred()
  const { services, dir } = makeServices({
    get: async (options: any) => {
      gets += 1
      if (gets === 2) {
        readSeen.resolve()
        await readRelease.promise
      }
      return { data: { id: options.path.id, title: "Current Title" } }
    },
  })
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle("Old Title"),
  })
  const tools = createCurrentTools(services)
  const keepPromise = execute(
    tools,
    "stm_title_review",
    { decision: "keep", expectedTitle: "Current Title" },
    context(),
  )
  await readSeen.promise
  // A concurrent unlock confirms the current title as the baseline while the
  // review's read is still pending: its digest becomes current.
  const unlocked = await services.state.update("ses_1", (current) => ({
    next: unlock(current ?? initialMeta(), hashTitle("Current Title")),
    result: true,
  }))
  assert.equal(unlocked.ok, true)
  readRelease.resolve()
  const result = await keepPromise
  assert.equal(result.status, "ok", "the unlock-established digest must not relock the session")
  assert.equal(result.decision, "keep")
  const state = readState(dir, "ses_1")
  assert.equal(state.locked, false)
  assert.equal(state.lockReason, "none")
  assert.equal(state.titleDigest, hashTitle("Current Title"))
  assert.equal(state.review, null)
})
