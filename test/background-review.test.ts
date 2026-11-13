// test/background-review.test.ts
import { after, mock, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG, type StmConfig } from "../src/config.js"
import { revokeReview } from "../src/background-state.js"
import { lockManually, resolveReview } from "../src/scheduler.js"
import { hashSessionID, hashTitle, initialMeta, createStateStore, createOperationGuard, type SessionMeta } from "../src/state.js"
import { createRootCache } from "../src/sdk.js"
import { createTranscriptPager } from "../src/transcript.js"
import { createBackgroundReviewer, type ReviewApplier } from "../src/background-review.js"
import type { ReviewSnapshot, ReviewSnapshots } from "../src/review-input.js"
import type { MutableMessage } from "../src/injection.js"
import type { StmServices } from "../src/tools.js"
import { fakeClient, type FakeHandler, type FakeHandlers } from "./fakes.js"

const PARENT = "ses_1"
const CHILD = "ses_child"
const REVIEW_ID = "review-1"
const TITLE = "Existing reviewable title"
const PROMPT_TEXT = "SECRET_TRANSCRIPT"
const CONTEXT_ID = "ctx-background-test"

const FIXTURE_SNAPSHOT: ReviewSnapshot = Object.freeze({
  contextID: CONTEXT_ID,
  sessionID: PARENT,
  parentUserID: "msg_user",
  records: JSON.stringify({ role: "user", messageID: "msg_user", partID: "part_user", kind: "text", text: PROMPT_TEXT }),
  messageCount: 1,
})

function fixtureSnapshots(): ReviewSnapshots {
  return {
    capture(sessionID: string, _messages: MutableMessage[]) {
      return sessionID === PARENT
        ? { ok: true, value: FIXTURE_SNAPSHOT }
        : { ok: false, reason: "review-snapshot-invalid" }
    },
    claim(sessionID: string, contextID: string, messageID: string) {
      if (sessionID !== PARENT) return { ok: false, reason: "review-context-session-mismatch" }
      if (contextID !== CONTEXT_ID || messageID !== "msg_dispatch") {
        return { ok: false, reason: "review-context-stale" }
      }
      return { ok: true, value: FIXTURE_SNAPSHOT }
    },
    release() {},
    discard() {},
    clear() {},
  }
}

const createdDirs: string[] = []

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
})

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
  settled: () => boolean
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (reason?: unknown) => void = () => {}
  let settled = false
  const promise = new Promise<T>((done, fail) => {
    resolve = (value) => {
      settled = true
      done(value)
    }
    reject = (reason) => {
      settled = true
      fail(reason)
    }
  })
  return { promise, resolve, reject, settled: () => settled }
}

function configured(overrides: Partial<StmConfig["review"]> = {}): StmConfig {
  return {
    review: {
      enabled: true,
      intervalMessages: 20,
      maxReminders: 3,
      backoffMultiplier: 2,
      reviewer: { timeoutSeconds: 120 },
      ...overrides,
    },
    historical: { ...DEFAULT_CONFIG.historical },
  }
}

function makeContext(options: {
  sessionID?: string
  messageID?: string
  agent?: string
  abort?: AbortController
} = {}): { context: ToolContext & { asks: any[] }; controller: AbortController } {
  const controller = options.abort ?? new AbortController()
  const asks: any[] = []
  const context = {
    sessionID: options.sessionID ?? PARENT,
    messageID: options.messageID ?? "msg_dispatch",
    agent: options.agent ?? "build",
    directory: "/tmp",
    worktree: "/tmp",
    abort: controller.signal,
    metadata() {},
    ask: async (input: any) => {
      asks.push(input)
    },
  } as unknown as ToolContext & { asks: any[] }
  context.asks = asks
  return { context, controller }
}

function completionMessages(promptMessageID: string, text: string): any[] {
  return [
    { info: { id: promptMessageID, sessionID: CHILD, role: "user" }, parts: [] },
    {
      info: { id: "msg_result", sessionID: CHILD, role: "assistant", parentID: promptMessageID, time: { completed: 1 } },
      parts: [{ id: "part_result", sessionID: CHILD, messageID: "msg_result", type: "text", text }],
    },
  ]
}

function statePath(dir: string, sessionID = PARENT): string {
  return join(dir, `${hashSessionID(sessionID)}.json`)
}

function readState(dir: string, sessionID = PARENT): SessionMeta | null {
  try {
    return JSON.parse(readFileSync(statePath(dir, sessionID), "utf8")) as SessionMeta
  } catch {
    return null
  }
}

async function revokeDirect(harness: Harness): Promise<void> {
  const result = await harness.services.state.update(PARENT, (current) => {
    assert.notEqual(current, null)
    return { next: revokeReview(current!, "background-revoked"), result: true }
  })
  assert.equal(result.ok, true)
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function flush(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function seedPendingReview(harness: Harness, overrides: Partial<SessionMeta> = {}): Promise<void> {
  await harness.services.state.save(PARENT, {
    ...initialMeta(),
    activity: 42,
    titleDigest: hashTitle(TITLE),
    review: { id: REVIEW_ID, remindersSent: 1, nextTriggerAt: 60 },
    ...overrides,
  })
}

type HarnessOptions = {
  config?: StmConfig
  title?: string
  dispatchParentID?: string
  handlers?: Partial<FakeHandlers>
  provider?: FakeHandler
  reviewSnapshots?: ReviewSnapshots | null
  toast?: (options: any) => Promise<unknown>
  now?: number
}

type Harness = {
  services: StmServices
  reviewer: ReturnType<typeof createBackgroundReviewer>
  dir: string
  calls: Array<{ method: string; options: any }>
  toastCalls: any[]
  applied: any[]
  setCreate: (handler: FakeHandler) => void
  setCompletion: (handler: FakeHandler) => void
  completeWith: (text: string) => void
  pendingCompletion: () => void
  promptMessageID: () => string | null
  now: () => number
  setNow: (value: number) => void
  state: () => SessionMeta | null
  waitForPrompt: () => Promise<void>
  setApplier: (applier: ReviewApplier) => void
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "stm-background-"))
  createdDirs.push(dir)
  let now = options.now ?? 1_000_000
  let createHandler: FakeHandler = options.handlers?.create ?? (async (input: any) => ({ data: { id: CHILD, parentID: input.body.parentID } }))
  let completionHandler: FakeHandler = async () => ({ data: [] })
  let promptMessageID: string | null = null
  const toastCalls: any[] = []
  const applied: any[] = []
  let applier: ReviewApplier = async () => ({ status: "applied" })
  const title = options.title ?? TITLE

  const baseHandlers: FakeHandlers = {
    get: async (input: any) => ({
      data: { id: input.path.id, title: input.path.id === PARENT ? title : "Child session", permission: [] },
    }),
    message: async (input: any) => ({
      data: {
        info: {
          id: input.path.messageID,
          sessionID: input.path.id,
          role: "assistant",
          parentID: options.dispatchParentID ?? "msg_user",
          providerID: "provider-1",
          modelID: "model-1",
        },
      },
    }),
    agents: async () => ({
      data: [
        { name: "build", mode: "primary" },
        { name: "session-title-reviewer", mode: "subagent" },
      ],
    }),
    messages: async (input: any) => input.path.id === CHILD ? completionHandler(input) : ({ data: [] }),
    create: async (input: any) => createHandler(input),
    promptAsync: async (input: any) => {
      promptMessageID = input.body.messageID
      return {}
    },
    abort: async () => ({ data: true }),
    status: async () => ({ data: { [CHILD]: { type: "idle" } } }),
  }

  const promptHandler = options.handlers?.promptAsync ?? baseHandlers.promptAsync!
  const handlers: FakeHandlers = {
    ...baseHandlers,
    ...options.handlers,
    create: async (input: any) => createHandler(input),
    promptAsync: async (input: any) => {
      promptMessageID = input.body.messageID
      return promptHandler(input)
    },
  }
  const fake = fakeClient(handlers)
  ;(fake.client as any).provider = {
    list: async (input: any) => {
      fake.calls.push({ method: "provider.list", options: input })
      if (options.provider !== undefined) return options.provider(input)
      return {
        data: {
          all: [{ id: "provider-1", models: { "model-1": { id: "model-1" }, "review-model": { id: "review-model" } } }],
          connected: ["provider-1"],
        },
      }
    },
  }
  const toast = options.toast ?? (async (input: any) => {
    toastCalls.push(input)
    return { data: true }
  })
  ;(fake.client as any).tui = { showToast: toast }

  const services: StmServices = {
    client: fake.client,
    config: options.config ?? configured(),
    state: createStateStore({ stateDir: dir }),
    transcripts: createTranscriptPager(),
    roots: createRootCache(fake.client),
    guard: createOperationGuard(),
    blocked: new Map(),
    now: () => now,
    ...(options.reviewSnapshots === null
      ? {}
      : { reviewSnapshots: options.reviewSnapshots ?? fixtureSnapshots() }),
  }

  const reviewer = createBackgroundReviewer(services, async (input, signal) => {
    applied.push({ input, signal })
    return applier(input, signal)
  })

  return {
    services,
    reviewer,
    dir,
    calls: fake.calls,
    toastCalls,
    applied,
    setCreate(handler) {
      createHandler = handler
    },
    setCompletion(handler) {
      completionHandler = handler
    },
    completeWith(text) {
      completionHandler = async () => ({ data: completionMessages(promptMessageID!, text) })
    },
    pendingCompletion() {
      completionHandler = async () => ({ data: [] })
    },
    promptMessageID: () => promptMessageID,
    now: () => now,
    setNow(value) {
      now = value
    },
    state: () => readState(dir),
    async waitForPrompt() {
      await waitFor(() => promptMessageID !== null, "review prompt")
    },
    setApplier(next) {
      applier = next
    },
  }
}

function startArgs(expectedTitle = TITLE, retry?: boolean) {
  return { reviewID: REVIEW_ID, expectedTitle, contextID: CONTEXT_ID, ...(retry === undefined ? {} : { retry }) }
}

function countCalls(harness: Harness, method: string): number {
  return harness.calls.filter((call) => call.method === method).length
}

function messagesFor(harness: Harness, sessionID: string): any[] {
  return harness.calls.filter((call) => call.method === "messages" && call.options.path.id === sessionID)
}

test("disabled review and missing reviewer refuse dispatch before any permission or remote work", async (t) => {
  const disabled = makeHarness({ config: configured({ enabled: false }) })
  t.after(() => disabled.reviewer.dispose())
  await seedPendingReview(disabled)
  const disabledContext = makeContext()
  assert.deepEqual(await disabled.reviewer.start(startArgs(), disabledContext.context), {
    status: "disabled",
  })
  assert.equal(disabledContext.context.asks.length, 0)
  assert.equal(disabled.calls.length, 0)

  const withoutReviewer = makeHarness({
    config: { review: { ...configured().review, reviewer: undefined }, historical: { ...DEFAULT_CONFIG.historical } },
  })
  t.after(() => withoutReviewer.reviewer.dispose())
  await seedPendingReview(withoutReviewer)
  const missingContext = makeContext()
  assert.deepEqual(await withoutReviewer.reviewer.start(startArgs(), missingContext.context), {
    status: "disabled",
  })
  assert.equal(missingContext.context.asks.length, 0)
  assert.equal(withoutReviewer.calls.length, 0)
})

test("a child session cannot claim the root session's retained context", async (t) => {
  const harness = makeHarness({
    handlers: {
      get: async (input: any) => ({
        data: { id: input.path.id, title: TITLE, ...(input.path.id === "ses_child_caller" ? { parentID: PARENT } : {}) },
      }),
    },
  })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const { context } = makeContext({ sessionID: "ses_child_caller" })
  const result = await harness.reviewer.start(startArgs(), context)
  assert.deepEqual(result, { status: "error", reason: "review-context-session-mismatch" })
  assert.equal(context.asks.length, 0)
  assert.equal(messagesFor(harness, PARENT).length, 0)
  assert.equal(countCalls(harness, "create"), 0)
  assert.equal(countCalls(harness, "promptAsync"), 0)
})

test("stale review IDs, wrong titles and locks create no transcript or child", async (t) => {
  const stale = makeHarness()
  t.after(() => stale.reviewer.dispose())
  await seedPendingReview(stale)
  const staleContext = makeContext()
  assert.deepEqual(await stale.reviewer.start({ ...startArgs(), reviewID: "review-other" }, staleContext.context), {
    status: "conflict",
    reason: "stale-review",
  })
  assert.equal(staleContext.context.asks.length, 0)
  assert.equal(messagesFor(stale, PARENT).length, 0)
  assert.equal(countCalls(stale, "create"), 0)
  assert.equal(countCalls(stale, "promptAsync"), 0)

  const wrongTitle = makeHarness()
  t.after(() => wrongTitle.reviewer.dispose())
  await seedPendingReview(wrongTitle)
  const titleContext = makeContext()
  assert.equal((await wrongTitle.reviewer.start(startArgs("A different title"), titleContext.context)).status, "conflict")
  assert.deepEqual(titleContext.context.asks.map((ask) => ask.permission), [
    "stm_title_review_start",
    "task",
    "stm_title_review",
  ])
  assert.equal(messagesFor(wrongTitle, PARENT).length, 0)
  assert.equal(countCalls(wrongTitle, "create"), 0)
  assert.equal(countCalls(wrongTitle, "promptAsync"), 0)
  assert.equal(wrongTitle.state()?.backgroundReview, null)

  const locked = makeHarness()
  t.after(() => locked.reviewer.dispose())
  await seedPendingReview(locked, { locked: true, lockReason: "manual" })
  const lockedContext = makeContext()
  assert.equal((await locked.reviewer.start(startArgs(), lockedContext.context)).status, "conflict")
  assert.equal(lockedContext.context.asks.length, 0)
  assert.equal(countCalls(locked, "create"), 0)
})

test("a denied task permission stops admission with zero transcript, create or prompt calls", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const { context } = makeContext()
  context.ask = async (input: any) => {
    context.asks.push(input)
    if (input.permission === "task") throw new Error("denied")
  }
  const result = await harness.reviewer.start(startArgs(), context)
  assert.equal(result.status, "denied")
  assert.deepEqual(context.asks.map((ask) => ask.permission), ["stm_title_review_start", "task"])
  assert.equal(messagesFor(harness, PARENT).length, 0)
  assert.equal(countCalls(harness, "create"), 0)
  assert.equal(countCalls(harness, "promptAsync"), 0)
  assert.equal(harness.state()?.backgroundReview, null)
})

test("an abort during admission returns aborted and starts no worker", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const { context, controller } = makeContext()
  context.ask = async (input: any) => {
    context.asks.push(input)
    controller.abort()
    throw new Error("aborted")
  }
  assert.equal((await harness.reviewer.start(startArgs(), context)).status, "aborted")
  assert.equal(messagesFor(harness, PARENT).length, 0)
  assert.equal(countCalls(harness, "create"), 0)
  assert.equal(countCalls(harness, "promptAsync"), 0)
  assert.equal(harness.state()?.backgroundReview, null)

  const preAborted = makeHarness()
  t.after(() => preAborted.reviewer.dispose())
  await seedPendingReview(preAborted)
  const aborted = new AbortController()
  aborted.abort()
  const { context: abortedContext } = makeContext({ abort: aborted })
  assert.equal((await preAborted.reviewer.start(startArgs(), abortedContext)).status, "aborted")
  assert.equal(preAborted.calls.length, 0)
})

test("the approved permission asks declare retained-text scope without transcript content or limits", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const { context } = makeContext()
  assert.equal((await harness.reviewer.start(startArgs(), context)).status, "queued")
  assert.deepEqual(context.asks.map((ask) => ask.permission), [
    "stm_title_review_start",
    "task",
    "stm_title_review",
  ])
  assert.deepEqual(context.asks[0].patterns, [PARENT])
  assert.deepEqual(context.asks[1].patterns, ["session-title-reviewer"])
  assert.deepEqual(context.asks[2].patterns, [PARENT])
  for (const ask of context.asks) {
    const encoded = JSON.stringify(ask.metadata)
    assert.equal(encoded.includes(PROMPT_TEXT), false)
    assert.equal(encoded.includes(TITLE), false)
    assert.equal(ask.metadata.delegation !== undefined, true)
    assert.equal(ask.metadata.input, "retained-text")
    assert.equal(ask.metadata.transcript, undefined)
    assert.equal(ask.metadata.maxBytes, undefined)
  }
})

test("start resolves queued while child creation is held, and concurrent starts reserve once", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const creation = deferred<any>()
  harness.setCreate(async () => creation.promise)

  const first = makeContext()
  const second = makeContext()
  const [one, two] = await Promise.all([
    harness.reviewer.start(startArgs(), first.context),
    harness.reviewer.start(startArgs(), second.context),
  ])
  assert.deepEqual([one.status, two.status].sort(), ["active", "queued"])
  assert.equal(creation.settled(), false)
  assert.equal(messagesFor(harness, PARENT).length, 0)
  assert.equal(countCalls(harness, "create"), 1)
  assert.equal(countCalls(harness, "promptAsync"), 0)

  creation.resolve({ data: { id: CHILD, parentID: PARENT } })
  await harness.waitForPrompt()
  assert.equal(countCalls(harness, "create"), 1)
  assert.equal(messagesFor(harness, PARENT).length, 0)

  const attempt = harness.state()?.backgroundReview
  assert.notEqual(attempt, null)
  assert.equal(attempt?.phase, "active")
  assert.equal(attempt?.childSessionID, CHILD)
  const prompt = harness.calls.find((call) => call.method === "promptAsync")
  assert.match(String(attempt?.promptMessageID), /^msg_[0-9A-HJKMNP-TV-Z]{26}$/)
  const encodedTime = String(attempt?.promptMessageID).slice(4, 14)
  const decodedTime = [...encodedTime].reduce(
    (value, character) => value * 32n + BigInt("0123456789ABCDEFGHJKMNPQRSTVWXYZ".indexOf(character)),
    0n,
  )
  assert.equal(decodedTime, BigInt(harness.now()))
  assert.equal(prompt?.options.body.messageID, attempt?.promptMessageID)
  assert.equal(prompt?.options.body.format, undefined)
  assert.match(String(prompt?.options.body.parts[0].text), /SECRET_TRANSCRIPT/)
  assert.ok(countCalls(harness, "message") >= 1 && countCalls(harness, "message") <= 2)
})

test("one admitted dispatch uses a parent point-read and never pages parent history", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)

  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()

  assert.equal(countCalls(harness, "message"), 1)
  assert.equal(messagesFor(harness, PARENT).length, 0)
})

test("successful completion applies once and duplicate idle, status and error events are ignored", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const { context } = makeContext()
  assert.equal((await harness.reviewer.start(startArgs(), context)).status, "queued")
  await harness.waitForPrompt()
  harness.completeWith('{"decision":"keep"}')

  await harness.reviewer.onEvent({ type: "session.idle", properties: { sessionID: "ses_unrelated" } })
  await harness.reviewer.onEvent({ type: "session.idle", properties: { sessionID: CHILD } })
  await harness.reviewer.onEvent({ type: "session.status", properties: { sessionID: CHILD, status: { type: "idle" } } })
  await harness.reviewer.onEvent({ type: "session.error", properties: { sessionID: CHILD, error: { name: "boom" } } })
  await harness.reviewer.onEvent({ type: "session.idle", properties: { sessionID: CHILD } })
  await waitFor(() => harness.applied.length === 1, "review application")
  await flush()

  assert.equal(harness.applied.length, 1)
  assert.deepEqual(harness.applied[0].input.structured, { decision: "keep" })
  assert.equal(harness.applied[0].input.parentID, PARENT)
  assert.equal(harness.applied[0].input.ownerID, harness.state()?.backgroundReview?.ownerID)
  assert.equal(harness.applied[0].input.attemptID, harness.state()?.backgroundReview?.id)
  assert.equal(messagesFor(harness, "ses_unrelated").length, 0)
  assert.equal(harness.toastCalls.length, 0)
})

test("polling finds a completion when no event arrives", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] })
  const harness = makeHarness()
  t.after(async () => {
    await harness.reviewer.dispose()
    mock.timers.reset()
  })
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()
  await flush()
  assert.equal(harness.applied.length, 0)

  harness.completeWith('{"decision":"keep"}')
  await flush()
  assert.equal(harness.applied.length, 0)
  mock.timers.tick(1000)
  await waitFor(() => harness.applied.length === 1, "polled completion")
  assert.deepEqual(harness.applied[0].input.structured, { decision: "keep" })
})

test("completion errors leave the review pending, never call the applier and emit a fixed notice", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  harness.completeWith("not json at all")
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()
  await waitFor(() => harness.state()?.backgroundReview?.phase === "failed", "child error failure")
  const attempt = harness.state()?.backgroundReview
  assert.equal(attempt?.failureCode, "background-child-error")
  assert.equal(harness.state()?.review?.id, REVIEW_ID)
  assert.equal(harness.applied.length, 0)
  assert.equal(harness.toastCalls.length, 1)
  assert.equal(harness.toastCalls[0].body.variant, "error")
  assert.match(String(harness.toastCalls[0].body.message), /failed/i)
  assert.equal(JSON.stringify(harness.toastCalls).includes("not json"), false)
})

test("a discarded result terminates the attempt with a fixed code and keeps the pending review", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  harness.setApplier(async () => ({ status: "discarded" }))
  harness.completeWith('{"decision":"rename","title":"Ignored"}')
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()
  await waitFor(() => harness.state()?.backgroundReview?.phase === "failed", "discarded failure")
  const attempt = harness.state()?.backgroundReview
  assert.equal(attempt?.failureCode, "background-result-discarded")
  assert.equal(harness.state()?.review?.id, REVIEW_ID)
  assert.equal(harness.toastCalls.length, 1)
  assert.match(String(harness.toastCalls[0].body.message), /discarded/i)
  assert.equal(harness.calls.some((call) => call.method === "update"), false)
})

test("an applier exception is contained as a fixed internal failure without an unhandled rejection", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  harness.setApplier(async () => {
    throw new Error("raw provider detail")
  })
  harness.completeWith('{"decision":"keep"}')
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()
  await waitFor(() => harness.state()?.backgroundReview?.phase === "failed", "internal failure")
  assert.equal(harness.state()?.backgroundReview?.failureCode, "background-internal-error")
  assert.equal(harness.toastCalls.length, 1)
  assert.equal(JSON.stringify(harness.toastCalls).includes("raw provider detail"), false)
})

test("timeout revokes authority, confirms the stop and emits a sanitised notice", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()
  const attempt = harness.state()?.backgroundReview
  assert.notEqual(attempt, null)
  harness.setNow((attempt?.deadline ?? 0) + 1)
  await harness.reviewer.onEvent({ type: "session.idle", properties: { sessionID: CHILD } })
  await waitFor(() => harness.state()?.backgroundReview?.phase === "failed", "timeout failure")

  const failed = harness.state()?.backgroundReview
  assert.equal(failed?.failureCode, "background-timeout")
  assert.equal(failed?.stop, "confirmed")
  assert.equal(harness.applied.length, 0)
  assert.equal(countCalls(harness, "abort"), 1)
  assert.equal(countCalls(harness, "status"), 1)
  assert.equal(harness.toastCalls.length, 1)
  assert.match(String(harness.toastCalls[0].body.message), /timed out/i)
  assert.equal(JSON.stringify(harness.toastCalls).includes("timeout"), false)
})

test("a create call without an ID is terminal with an unconfirmed stop and no automatic second child", async (t) => {
  const harness = makeHarness({ handlers: { create: async () => ({}) } })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await waitFor(() => harness.state()?.backgroundReview?.phase === "failed", "create failure")
  const failed = harness.state()?.backgroundReview
  assert.equal(failed?.failureCode, "background-create-failed")
  assert.equal(failed?.stop, "pending")
  assert.equal(failed?.childSessionID, null)
  assert.equal(countCalls(harness, "create"), 1)
  assert.equal(countCalls(harness, "promptAsync"), 0)
  assert.equal(harness.toastCalls.length, 1)

  const retryContext = makeContext()
  assert.equal((await harness.reviewer.start(startArgs(TITLE, true), retryContext.context)).status, "failed")
  assert.equal(retryContext.context.asks.length, 0)
  assert.equal(countCalls(harness, "create"), 1)
})

test("cancel revokes owned authority immediately and a late completion cannot apply", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()

  await harness.reviewer.cancel(PARENT, "manual-lock")
  const cancelled = harness.state()?.backgroundReview
  assert.equal(cancelled?.phase, "failed")
  assert.equal(cancelled?.failureCode, "background-revoked")
  assert.equal(cancelled?.stop, "confirmed")
  assert.equal(harness.state()?.review?.id, REVIEW_ID)
  assert.equal(countCalls(harness, "abort"), 1)

  harness.completeWith('{"decision":"keep"}')
  await harness.reviewer.onEvent({ type: "session.idle", properties: { sessionID: CHILD } })
  await flush()
  assert.equal(harness.applied.length, 0)
  assert.equal(harness.toastCalls.length, 0)
})

test("dispose revokes authority, stops the child, clears work and makes later events inert", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()

  await harness.reviewer.dispose()
  const disposed = harness.state()?.backgroundReview
  assert.equal(disposed?.phase, "failed")
  assert.equal(disposed?.failureCode, "background-revoked")
  assert.equal(disposed?.stop, "confirmed")
  assert.equal(countCalls(harness, "abort"), 1)

  harness.completeWith('{"decision":"keep"}')
  await harness.reviewer.onEvent({ type: "session.idle", properties: { sessionID: CHILD } })
  await flush()
  assert.equal(harness.applied.length, 0)
  const createCalls = countCalls(harness, "create")
  const lateContext = makeContext()
  assert.equal((await harness.reviewer.start(startArgs(), lateContext.context)).status, "error")
  assert.equal(countCalls(harness, "create"), createCalls)
  assert.equal(lateContext.context.asks.length, 0)
  await harness.reviewer.dispose()
})

test("a live foreign reservation blocks dispatch; after expiry a confirmed stop permits explicit retry", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  const deadline = harness.now() + 60_000
  await seedPendingReview(harness, {
    backgroundReview: {
      id: "attempt-foreign",
      reviewID: REVIEW_ID,
      ownerID: "owner-foreign",
      phase: "active",
      titleDigest: hashTitle(TITLE),
      cutoffMessageID: "msg_dispatch",
      activityAtDispatch: 42,
      deadline,
      childSessionID: CHILD,
      promptMessageID: "msg_prompt",
      stop: "pending",
      failureCode: null,
    },
  })

  const blockedContext = makeContext()
  assert.equal((await harness.reviewer.start(startArgs(), blockedContext.context)).status, "active")
  assert.equal(blockedContext.context.asks.length, 0)
  assert.equal(countCalls(harness, "create"), 0)
  assert.equal(messagesFor(harness, PARENT).length, 0)

  harness.setNow(deadline + 1)
  await harness.reviewer.reconcile(PARENT)
  const expired = harness.state()?.backgroundReview
  assert.equal(expired?.phase, "failed")
  assert.equal(expired?.stop, "confirmed")
  assert.equal(countCalls(harness, "abort"), 1)

  const ordinary = makeContext()
  assert.equal((await harness.reviewer.start(startArgs(), ordinary.context)).status, "failed")
  assert.equal(ordinary.context.asks.length, 0)
  assert.equal(countCalls(harness, "create"), 0)

  const retry = makeContext()
  assert.equal((await harness.reviewer.start(startArgs(TITLE, true), retry.context)).status, "queued")
  await harness.waitForPrompt()
  assert.equal(countCalls(harness, "create"), 1)
  assert.notEqual(harness.state()?.backgroundReview?.id, "attempt-foreign")
})

test("an expired foreign reservation with no known child or an unconfirmed stop remains blocked", async (t) => {
  const noChild = makeHarness()
  t.after(() => noChild.reviewer.dispose())
  const deadline = noChild.now() + 60_000
  await seedPendingReview(noChild, {
    backgroundReview: {
      id: "attempt-no-child",
      reviewID: REVIEW_ID,
      ownerID: "owner-foreign",
      phase: "active",
      titleDigest: hashTitle(TITLE),
      cutoffMessageID: "msg_dispatch",
      activityAtDispatch: 42,
      deadline,
      childSessionID: null,
      promptMessageID: null,
      stop: "not-started",
      failureCode: null,
    },
  })
  noChild.setNow(deadline + 1)
  await noChild.reviewer.reconcile(PARENT)
  assert.equal(noChild.state()?.backgroundReview?.phase, "failed")
  assert.equal(noChild.state()?.backgroundReview?.stop, "pending")
  const noChildRetry = makeContext()
  assert.equal((await noChild.reviewer.start(startArgs(TITLE, true), noChildRetry.context)).status, "failed")
  assert.equal(noChildRetry.context.asks.length, 0)
  assert.equal(countCalls(noChild, "create"), 0)

  const unconfirmed = makeHarness({ handlers: { status: async () => ({ data: {} }) } })
  t.after(() => unconfirmed.reviewer.dispose())
  const secondDeadline = unconfirmed.now() + 60_000
  await seedPendingReview(unconfirmed, {
    backgroundReview: {
      id: "attempt-unconfirmed",
      reviewID: REVIEW_ID,
      ownerID: "owner-foreign",
      phase: "active",
      titleDigest: hashTitle(TITLE),
      cutoffMessageID: "msg_dispatch",
      activityAtDispatch: 42,
      deadline: secondDeadline,
      childSessionID: CHILD,
      promptMessageID: "msg_prompt",
      stop: "pending",
      failureCode: null,
    },
  })
  unconfirmed.setNow(secondDeadline + 1)
  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "))
  }
  t.after(() => {
    console.error = originalError
  })
  await unconfirmed.reviewer.reconcile(PARENT)
  assert.equal(unconfirmed.state()?.backgroundReview?.phase, "failed")
  assert.equal(unconfirmed.state()?.backgroundReview?.stop, "pending")
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /^\[opencode-stm\] background title review stop could not be confirmed$/)
  const unconfirmedRetry = makeContext()
  assert.equal((await unconfirmed.reviewer.start(startArgs(TITLE, true), unconfirmedRetry.context)).status, "failed")
  assert.equal(unconfirmedRetry.context.asks.length, 0)
  assert.equal(countCalls(unconfirmed, "create"), 0)
})

test("a failed toast call falls back to a short fixed stderr diagnostic", async (t) => {
  const harness = makeHarness({
    toast: async () => {
      throw new Error("tui unavailable: raw detail")
    },
    handlers: { create: async () => ({}) },
  })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "))
  }
  t.after(() => {
    console.error = originalError
  })
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await waitFor(() => harness.state()?.backgroundReview?.phase === "failed", "toast fallback failure")
  await flush()
  assert.equal(errors.length, 1)
  assert.equal(errors[0]!.includes("raw detail"), false)
  assert.equal(
    errors[0],
    "[opencode-stm] Background title review failed. Check the session title before dispatching again.",
  )
})

test("a missing configured reviewer returns its safe SDK reason before admission", async (t) => {
  const harness = makeHarness({
    handlers: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
  })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const { context } = makeContext()
  const result = await harness.reviewer.start(startArgs(), context)
  assert.equal(result.status, "disabled")
  assert.equal(result.reason, "sdk: review context reviewer agent missing")
  assert.equal(context.asks.length, 0)
  assert.equal(messagesFor(harness, PARENT).length, 0)
  assert.equal(countCalls(harness, "create"), 0)
  assert.equal(countCalls(harness, "promptAsync"), 0)
})

test("an explicit unavailable model reports the setting-scoped catalogue failure without fallback", async (t) => {
  const harness = makeHarness({
    config: configured({ reviewer: { model: "provider-1/not-connected", timeoutSeconds: 120 } }),
  })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const { context } = makeContext()

  const result = await harness.reviewer.start(startArgs(), context)

  assert.deepEqual(result, {
    status: "disabled",
    reason: "config: review.reviewer.model is not available from a connected provider",
  })
  assert.equal(context.asks.length, 0)
  assert.equal(countCalls(harness, "create"), 0)
  assert.equal(countCalls(harness, "promptAsync"), 0)
  assert.equal(countCalls(harness, "provider.list"), 1)
})

test("the dispatch assistant must point to the captured parent user before permissions are asked", async (t) => {
  const harness = makeHarness({ dispatchParentID: "msg_different_user" })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const { context } = makeContext()

  assert.deepEqual(await harness.reviewer.start(startArgs(), context), {
    status: "error",
    reason: "review-context-parent-mismatch",
  })
  assert.equal(context.asks.length, 0)
  assert.equal(countCalls(harness, "create"), 0)
  assert.equal(countCalls(harness, "promptAsync"), 0)
})

test("a restart can report active or uncertain recovery status without an in-memory snapshot", async (t) => {
  const active = makeHarness({ reviewSnapshots: null })
  t.after(() => active.reviewer.dispose())
  const deadline = active.now() + 60_000
  await seedPendingReview(active, {
    backgroundReview: {
      id: "attempt-foreign",
      reviewID: REVIEW_ID,
      ownerID: "owner-foreign",
      phase: "active",
      titleDigest: hashTitle(TITLE),
      cutoffMessageID: "msg_dispatch",
      activityAtDispatch: 42,
      deadline,
      childSessionID: CHILD,
      promptMessageID: "msg_prompt",
      stop: "pending",
      failureCode: null,
    },
  })
  assert.deepEqual(await active.reviewer.start(startArgs(), makeContext().context), {
    status: "active",
    reason: "foreign-owner",
  })

  const uncertain = makeHarness({ reviewSnapshots: null })
  t.after(() => uncertain.reviewer.dispose())
  await seedPendingReview(uncertain, {
    backgroundReview: {
      id: "attempt-uncertain",
      reviewID: REVIEW_ID,
      ownerID: "owner-foreign",
      phase: "uncertain",
      titleDigest: hashTitle(TITLE),
      cutoffMessageID: "msg_dispatch",
      activityAtDispatch: 42,
      deadline: uncertain.now() + 60_000,
      childSessionID: CHILD,
      promptMessageID: "msg_prompt",
      stop: "confirmed",
      failureCode: "background-uncertain-write",
    },
  })
  assert.deepEqual(await uncertain.reviewer.start(startArgs(TITLE, true), makeContext().context), { status: "uncertain" })
})

test("a pending review with no retained snapshot fails explicitly before admission", async (t) => {
  const harness = makeHarness({ reviewSnapshots: null })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const { context } = makeContext()

  assert.deepEqual(await harness.reviewer.start(startArgs(), context), {
    status: "error",
    reason: "review-context-missing",
  })
  assert.equal(context.asks.length, 0)
  assert.equal(countCalls(harness, "agents"), 0)
  assert.equal(countCalls(harness, "create"), 0)
})

test("caller abort after queued acceptance does not cancel detached work", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const { context, controller } = makeContext()
  assert.equal((await harness.reviewer.start(startArgs(), context)).status, "queued")
  controller.abort()
  await harness.waitForPrompt()
  harness.completeWith('{"decision":"keep"}')
  await harness.reviewer.onEvent({ type: "session.idle", properties: { sessionID: CHILD } })
  await waitFor(() => harness.applied.length === 1, "detached completion")
  assert.equal(countCalls(harness, "abort"), 0)
})

test("cancel during a held create retains an unconfirmed late stop and starts no prompt", async (t) => {
  const gate = deferred<any>()
  const harness = makeHarness({ handlers: { create: async () => gate.promise } })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await waitFor(() => countCalls(harness, "create") === 1, "held create")

  await harness.reviewer.cancel(PARENT, "manual-lock")
  const cancelled = harness.state()?.backgroundReview
  assert.equal(cancelled?.phase, "failed")
  assert.equal(cancelled?.stop, "pending")
  assert.equal(cancelled?.childSessionID, null)

  gate.resolve({ data: { id: CHILD, parentID: PARENT } })
  await flush(8)
  assert.equal(harness.state()?.backgroundReview?.stop, "pending")
  assert.equal(countCalls(harness, "abort"), 0)
  assert.equal(countCalls(harness, "promptAsync"), 0)
  assert.equal(harness.applied.length, 0)
  const retry = makeContext()
  assert.equal((await harness.reviewer.start(startArgs(TITLE, true), retry.context)).status, "failed")
  assert.equal(retry.context.asks.length, 0)
})

test("dispose during a held create retains an unconfirmed late stop and blocks a restarted retry", async (t) => {
  const gate = deferred<any>()
  const harness = makeHarness({ handlers: { create: async () => gate.promise } })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await waitFor(() => countCalls(harness, "create") === 1, "held create")

  await harness.reviewer.dispose()
  const disposed = harness.state()?.backgroundReview
  assert.equal(disposed?.phase, "failed")
  assert.equal(disposed?.stop, "pending")
  assert.equal(disposed?.childSessionID, null)

  gate.resolve({ data: { id: CHILD, parentID: PARENT } })
  await flush(8)
  assert.equal(harness.state()?.backgroundReview?.stop, "pending")
  assert.equal(countCalls(harness, "abort"), 0)
  assert.equal(countCalls(harness, "promptAsync"), 0)
  assert.equal(harness.applied.length, 0)

  const restarted = createBackgroundReviewer(harness.services, async () => ({ status: "applied" }))
  t.after(() => restarted.dispose())
  const retry = makeContext()
  assert.equal((await restarted.start(startArgs(TITLE, true), retry.context)).status, "failed")
  assert.equal(retry.context.asks.length, 0)
})

async function runLateCreateSettlementRace(
  mode: "cancel" | "dispose",
  abortHandler?: FakeHandler,
): Promise<{ harness: Harness; settlement: Promise<void>; retry: any; createCalls: () => number }> {
  const gate = deferred<any>()
  let harness!: Harness
  let settlement: Promise<void> | null = null
  harness = makeHarness({
    handlers: {
      create: async () => {
        await gate.promise
        return {
          get data() {
            settlement =
              mode === "cancel"
                ? harness.reviewer.cancel(PARENT, "manual-lock")
                : harness.reviewer.dispose()
            return { id: CHILD, parentID: PARENT }
          },
        }
      },
      ...(abortHandler === undefined ? {} : { abort: abortHandler }),
    },
  })
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await waitFor(() => countCalls(harness, "create") === 1, `held create for ${mode}`)
  gate.resolve({ data: { id: CHILD, parentID: PARENT } })
  await waitFor(() => settlement !== null, `${mode} settlement`)
  return { harness, settlement: settlement!, retry: makeContext(), createCalls: () => countCalls(harness, "create") }
}

test("a confirmed late stop after held-create cancellation or disposal permits explicit retry", async (t) => {
  for (const mode of ["cancel", "dispose"] as const) {
    const { harness, settlement, retry, createCalls } = await runLateCreateSettlementRace(mode)
    t.after(() => harness.reviewer.dispose())
    await waitFor(
      () => harness.state()?.backgroundReview?.stop === "confirmed",
      `${mode} late stop confirmation`,
    )
    await settlement
    assert.equal(harness.state()?.backgroundReview?.phase, "failed", mode)
    assert.equal(harness.state()?.backgroundReview?.stop, "confirmed", mode)
    assert.equal(countCalls(harness, "abort"), 1, mode)
    assert.equal(countCalls(harness, "promptAsync"), 0, mode)

    const restarted = mode === "dispose"
      ? createBackgroundReviewer(harness.services, async () => ({ status: "applied" }))
      : harness.reviewer
    if (restarted !== harness.reviewer) t.after(() => restarted.dispose())
    assert.equal((await restarted.start(startArgs(TITLE, true), retry.context)).status, "queued", mode)
    assert.equal(retry.context.asks.length, 3, mode)
    await waitFor(() => createCalls() === 2, `${mode} retry create`)
    await restarted.dispose()
  }
})

test("an unconfirmed late stop after held-create cancellation or disposal remains blocked", async (t) => {
  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "))
  }
  t.after(() => {
    console.error = originalError
  })
  for (const mode of ["cancel", "dispose"] as const) {
    const { harness, settlement, retry, createCalls } = await runLateCreateSettlementRace(mode, async () => ({ data: false }))
    t.after(() => harness.reviewer.dispose())
    await waitFor(() => countCalls(harness, "abort") === 1, `${mode} late stop attempt`)
    await settlement
    await flush(8)
    const failed = harness.state()?.backgroundReview
    assert.equal(failed?.phase, "failed", mode)
    assert.equal(failed?.stop, "pending", mode)
    assert.equal(countCalls(harness, "promptAsync"), 0, mode)

    const restarted = mode === "dispose"
      ? createBackgroundReviewer(harness.services, async () => ({ status: "applied" }))
      : harness.reviewer
    if (restarted !== harness.reviewer) t.after(() => restarted.dispose())
    assert.equal((await restarted.start(startArgs(TITLE, true), retry.context)).status, "failed", mode)
    assert.equal(retry.context.asks.length, 0, mode)
    assert.equal(createCalls(), 1, mode)
    await restarted.dispose()
  }
  assert.equal(
    errors.every((line) => line === "[opencode-stm] background title review stop could not be confirmed"),
    true,
  )
  assert.equal(errors.length, 2)
})

test("dispose during a held prompt revokes first and leaves no late application", async (t) => {
  const gate = deferred<any>()
  const harness = makeHarness({ handlers: { promptAsync: async () => gate.promise } })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await waitFor(() => countCalls(harness, "promptAsync") === 1, "held prompt")

  await harness.reviewer.dispose()
  const disposed = harness.state()?.backgroundReview
  assert.equal(disposed?.phase, "failed")
  assert.equal(disposed?.stop, "confirmed")
  assert.equal(countCalls(harness, "abort"), 1)

  gate.resolve({})
  await flush(8)
  assert.equal(harness.applied.length, 0)
})

test("cancel during a held completion read prevents a late result from applying", async (t) => {
  const gate = deferred<any>()
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  harness.setCompletion(async () => gate.promise)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()
  await waitFor(() => messagesFor(harness, CHILD).length === 1, "held completion read")

  await harness.reviewer.cancel(PARENT, "manual-lock")
  assert.equal(harness.state()?.backgroundReview?.phase, "failed")
  assert.equal(harness.state()?.backgroundReview?.stop, "confirmed")
  assert.equal(countCalls(harness, "abort"), 1)

  gate.resolve({ data: completionMessages(harness.promptMessageID()!, '{"decision":"keep"}') })
  await flush(8)
  assert.equal(harness.applied.length, 0)
})

test("a held abort is bounded and records an unconfirmed stop", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] })
  const harness = makeHarness({ handlers: { abort: async () => new Promise<any>(() => {}) } })
  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "))
  }
  t.after(() => {
    console.error = originalError
    mock.timers.reset()
  })
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()

  const cancelling = harness.reviewer.cancel(PARENT, "manual-lock")
  await waitFor(() => countCalls(harness, "abort") === 1, "held abort request")
  mock.timers.tick(5000)
  await cancelling
  const cancelled = harness.state()?.backgroundReview
  assert.equal(cancelled?.phase, "failed")
  assert.equal(cancelled?.stop, "pending")
  assert.equal(errors.length, 1)
  assert.equal(errors[0], "[opencode-stm] background title review stop could not be confirmed")
})

test("dispose racing acceptance revokes the reserved attempt instead of leaving an orphan", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const originalGuard = harness.services.guard
  const gate = deferred<void>()
  let guardEntered = false
  harness.services.guard = {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      guardEntered = true
      await gate.promise
      return originalGuard.run(key, fn)
    },
  }
  const starting = harness.reviewer.start(startArgs(), makeContext().context)
  await waitFor(() => guardEntered, "admission guard")
  await harness.reviewer.dispose()
  gate.resolve()
  assert.equal((await starting).status, "aborted")
  const reserved = harness.state()?.backgroundReview
  assert.equal(reserved?.phase, "failed")
  assert.equal(reserved?.stop, "not-started")
  assert.equal(countCalls(harness, "create"), 0)
  assert.equal(countCalls(harness, "promptAsync"), 0)
})

test("a no-ID create failure after external revocation preserves the unconfirmed stop", async (t) => {
  const gate = deferred<any>()
  const harness = makeHarness({ handlers: { create: async () => gate.promise } })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await waitFor(() => countCalls(harness, "create") === 1, "held create")

  await revokeDirect(harness)
  assert.equal(harness.state()?.backgroundReview?.phase, "failed")
  assert.equal(harness.state()?.backgroundReview?.stop, "not-started")

  gate.resolve({})
  await waitFor(() => harness.toastCalls.length === 1, "create failure notice")
  assert.equal(harness.state()?.backgroundReview?.stop, "pending")
  assert.equal(harness.state()?.backgroundReview?.childSessionID, null)
  assert.equal(countCalls(harness, "promptAsync"), 0)

  const retry = makeContext()
  assert.equal((await harness.reviewer.start(startArgs(TITLE, true), retry.context)).status, "failed")
  assert.equal(retry.context.asks.length, 0)
  assert.equal(countCalls(harness, "create"), 1)
})

test("cancel preserves an unconfirmed stop for an in-flight create after external revocation", async (t) => {
  const gate = deferred<any>()
  const harness = makeHarness({ handlers: { create: async () => gate.promise } })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await waitFor(() => countCalls(harness, "create") === 1, "held create")

  await revokeDirect(harness)
  await harness.reviewer.cancel(PARENT, "manual-lock")
  assert.equal(harness.state()?.backgroundReview?.phase, "failed")
  assert.equal(harness.state()?.backgroundReview?.stop, "pending")
  assert.equal(countCalls(harness, "abort"), 0)

  gate.resolve({})
  await flush(8)
  const retry = makeContext()
  assert.equal((await harness.reviewer.start(startArgs(TITLE, true), retry.context)).status, "failed")
  assert.equal(retry.context.asks.length, 0)
  assert.equal(countCalls(harness, "create"), 1)
})

test("authority revoked after child-ID persistence stops the child without sending the prompt", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const originalUpdate = harness.services.state.update.bind(harness.services.state)
  const originalPresent = harness.services.state.updateIfPresent.bind(harness.services.state)
  const reached = deferred<void>()
  const release = deferred<void>()
  let held = false
  harness.services.state.updateIfPresent = async (sessionID, fn) => {
    const result = await originalPresent(sessionID, fn)
    const persisted = readState(harness.dir)
    if (!held && typeof persisted?.backgroundReview?.promptMessageID === "string") {
      held = true
      reached.resolve()
      await release.promise
    }
    return result
  }

  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await reached.promise
  assert.equal(countCalls(harness, "promptAsync"), 0)
  const revoked = await originalUpdate(PARENT, (current) => {
    assert.notEqual(current, null)
    return { next: revokeReview(current!, "background-revoked"), result: true }
  })
  assert.equal(revoked.ok, true)
  release.resolve()
  await waitFor(
    () => countCalls(harness, "promptAsync") === 1 || countCalls(harness, "abort") === 1,
    "pre-prompt decision",
  )

  assert.equal(countCalls(harness, "promptAsync"), 0)
  assert.equal(countCalls(harness, "abort"), 1)
  assert.equal(harness.applied.length, 0)
  assert.equal(harness.state()?.backgroundReview?.phase, "failed")
  assert.equal(harness.toastCalls.length, 0)
})

test("an abort while the reservation update is held prevents the reservation", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  const originalPresent = harness.services.state.updateIfPresent.bind(harness.services.state)
  const entered = deferred<void>()
  const release = deferred<void>()
  let held = false
  harness.services.state.updateIfPresent = async (sessionID, fn) => {
    if (!held) {
      held = true
      entered.resolve()
      await release.promise
    }
    return originalPresent(sessionID, fn)
  }

  const { context, controller } = makeContext()
  const starting = harness.reviewer.start(startArgs(), context)
  await entered.promise
  controller.abort()
  release.resolve()
  assert.equal((await starting).status, "aborted")
  assert.equal(harness.state()?.backgroundReview, null)
  assert.equal(messagesFor(harness, PARENT).length, 0)
  assert.equal(countCalls(harness, "create"), 0)
  assert.equal(countCalls(harness, "promptAsync"), 0)
})

test("cleanup does not recreate metadata removed after its read", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()

  const originalLoad = harness.services.state.load.bind(harness.services.state)
  let removed = false
  harness.services.state.load = async (sessionID) => {
    const loaded = await originalLoad(sessionID)
    if (!removed && sessionID === PARENT) {
      removed = true
      rmSync(statePath(harness.dir), { force: true })
    }
    return loaded
  }

  await harness.reviewer.cancel(PARENT, "manual-lock")
  assert.equal(removed, true)
  assert.equal(existsSync(statePath(harness.dir)), false)
  assert.equal(countCalls(harness, "abort"), 1)
})

test("child deletion fails the parent attempt with a confirmed stop and no late application", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()

  await harness.reviewer.onEvent({ type: "session.deleted", properties: { info: { id: CHILD } } })
  await waitFor(() => harness.state()?.backgroundReview?.phase === "failed", "child deletion failure")
  const failed = harness.state()?.backgroundReview
  assert.equal(failed?.failureCode, "background-child-error")
  assert.equal(failed?.stop, "confirmed")
  assert.equal(harness.state()?.review?.id, REVIEW_ID)
  assert.equal(countCalls(harness, "abort"), 0)

  harness.completeWith('{"decision":"keep"}')
  await harness.reviewer.onEvent({ type: "session.idle", properties: { sessionID: CHILD } })
  await flush()
  assert.equal(harness.applied.length, 0)
})

test("parent deletion cancels the owned job before state removal and never recreates it", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()

  await harness.reviewer.onEvent({ type: "session.deleted", properties: { info: { id: PARENT } } })
  assert.equal(harness.state()?.backgroundReview?.phase, "failed")
  assert.equal(harness.state()?.backgroundReview?.failureCode, "background-revoked")
  assert.equal(countCalls(harness, "abort"), 1)
  await harness.services.state.removeOwned(PARENT)
  assert.equal(harness.state(), null)

  harness.completeWith('{"decision":"keep"}')
  await harness.reviewer.onEvent({ type: "session.idle", properties: { sessionID: CHILD } })
  await flush()
  assert.equal(harness.applied.length, 0)
  assert.equal(harness.state(), null)
})

test("dispose requests a fresh bounded stop after aborting the job signal", async (t) => {
  const abortSignals: boolean[] = []
  const harness = makeHarness({
    handlers: {
      abort: async (input: any) => {
        abortSignals.push(input.signal?.aborted === true)
        return { data: true }
      },
    },
  })
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()

  await harness.reviewer.dispose()
  assert.deepEqual(abortSignals, [false])
  assert.equal(harness.state()?.backgroundReview?.phase, "failed")
  assert.equal(harness.state()?.backgroundReview?.stop, "confirmed")
})

test("an uncertain restart record blocks dispatch without reapplying or creating a child", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness, {
    backgroundReview: {
      id: "attempt-uncertain",
      reviewID: REVIEW_ID,
      ownerID: "owner-foreign",
      phase: "uncertain",
      titleDigest: hashTitle(TITLE),
      cutoffMessageID: "msg_dispatch",
      activityAtDispatch: 42,
      deadline: harness.now() + 60_000,
      childSessionID: CHILD,
      promptMessageID: "msg_prompt",
      stop: "confirmed",
      failureCode: "background-uncertain-write",
    },
  })

  const { context } = makeContext()
  assert.deepEqual(await harness.reviewer.start(startArgs(TITLE, true), context), { status: "uncertain" })
  assert.equal(context.asks.length, 0)
  assert.equal(countCalls(harness, "create"), 0)
  assert.equal(harness.applied.length, 0)
  await harness.reviewer.reconcile(PARENT)
  const unchanged = harness.state()?.backgroundReview
  assert.equal(unchanged?.id, "attempt-uncertain")
  assert.equal(unchanged?.phase, "uncertain")
  assert.equal(harness.applied.length, 0)
  assert.equal(countCalls(harness, "create"), 0)
})

test("cancellation records a confirmed stop on an already-uncertain attempt", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()
  const marked = await harness.services.state.updateIfPresent(PARENT, (current) => {
    assert.notEqual(current.backgroundReview, null)
    return {
      next: {
        ...current,
        backgroundReview: {
          ...current.backgroundReview!,
          phase: "uncertain",
          failureCode: "background-uncertain-write",
        },
      },
      result: true,
    }
  })
  assert.equal(marked.ok, true)

  await harness.reviewer.cancel(PARENT, "manual-lock")
  assert.equal(countCalls(harness, "abort"), 1)
  const saved = harness.state()?.backgroundReview
  assert.equal(saved?.phase, "uncertain")
  assert.equal(saved?.stop, "confirmed")
})

test("a second instance stops the known child after a shared explicit lock or resolution", async (t) => {
  for (const change of ["lock", "resolution"] as const) {
    const harness = makeHarness()
    t.after(() => harness.reviewer.dispose())
    const second = createBackgroundReviewer(harness.services, async () => ({ status: "applied" }))
    t.after(() => second.dispose())
    await seedPendingReview(harness)
    assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
    await harness.waitForPrompt()
    const owned = harness.state()?.backgroundReview
    assert.equal(owned?.phase, "active")

    // Ordinary lazy reconciliation must not steal a live foreign reservation.
    await second.reconcile(PARENT)
    assert.equal(countCalls(harness, "abort"), 0, change)
    assert.equal(harness.state()?.backgroundReview?.phase, "active", change)

    await harness.services.state.update(PARENT, (current) => ({
      next: change === "lock"
        ? lockManually(current ?? initialMeta())
        : resolveReview(current ?? initialMeta(), hashTitle(TITLE)),
      result: true,
    }))
    const revoked = harness.state()?.backgroundReview
    assert.equal(revoked?.phase, "failed", change)
    assert.equal(revoked?.id, owned?.id, change)
    assert.equal(revoked?.ownerID, owned?.ownerID, change)

    await second.cancel(PARENT, change === "lock" ? "manual-lock" : "explicit-resolution")
    await waitFor(
      () => harness.state()?.backgroundReview?.stop === "confirmed",
      `${change} foreign stop confirmation`,
    )
    assert.equal(countCalls(harness, "abort"), 1, change)
    const stopped = harness.state()?.backgroundReview
    assert.equal(stopped?.id, owned?.id, change)
    assert.equal(stopped?.ownerID, owned?.ownerID, change)
    assert.equal(stopped?.phase, "failed", change)
  }
})

test("a second instance stops an active foreign child on parent deletion before metadata removal", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  const second = createBackgroundReviewer(harness.services, async () => ({ status: "applied" }))
  t.after(() => second.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()
  const owned = harness.state()?.backgroundReview
  assert.equal(owned?.phase, "active")

  await second.onEvent({ type: "session.deleted", properties: { info: { id: PARENT } } })
  await waitFor(() => countCalls(harness, "abort") === 1, "deletion foreign stop")
  await waitFor(
    () => harness.state()?.backgroundReview?.stop === "confirmed",
    "deletion foreign stop confirmation",
  )
  assert.equal(harness.state()?.backgroundReview?.id, owned?.id)
  assert.equal(harness.state()?.backgroundReview?.ownerID, owned?.ownerID)
  assert.equal(harness.state()?.backgroundReview?.phase, "failed")

  await harness.services.state.removeOwned(PARENT)
  assert.equal(harness.state(), null)
})

test("a cross-instance stop with missing status remains pending and emits a sanitised diagnostic", async (t) => {
  const harness = makeHarness({ handlers: { status: async () => ({ data: {} }) } })
  t.after(() => harness.reviewer.dispose())
  const second = createBackgroundReviewer(harness.services, async () => ({ status: "applied" }))
  t.after(() => second.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()
  await harness.services.state.update(PARENT, (current) => ({
    next: lockManually(current ?? initialMeta()),
    result: true,
  }))

  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "))
  }
  t.after(() => {
    console.error = originalError
  })

  await second.cancel(PARENT, "manual-lock")
  assert.equal(countCalls(harness, "abort"), 1)
  assert.equal(harness.state()?.backgroundReview?.stop, "pending")
  assert.deepEqual(errors, ["[opencode-stm] background title review stop could not be confirmed"])
})

test("a late cross-instance stop cannot mark a replacement child or recreate deleted metadata", async (t) => {
  for (const mode of ["replacement", "deleted"] as const) {
    const abortStarted = deferred<void>()
    const release = deferred<void>()
    const harness = makeHarness({
      handlers: {
        abort: async () => {
          abortStarted.resolve()
          await release.promise
          return { data: true }
        },
      },
    })
    t.after(() => harness.reviewer.dispose())
    const second = createBackgroundReviewer(harness.services, async () => ({ status: "applied" }))
    t.after(() => second.dispose())
    await seedPendingReview(harness)
    assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
    await harness.waitForPrompt()
    await harness.services.state.update(PARENT, (current) => ({
      next: lockManually(current ?? initialMeta()),
      result: true,
    }))

    const cancelling = second.cancel(PARENT, "manual-lock")
    await abortStarted.promise
    if (mode === "replacement") {
      await harness.services.state.update(PARENT, (current) => {
        if (current === null || current.backgroundReview === null) throw new Error("expected stored attempt")
        return {
          next: {
            ...current,
            backgroundReview: {
              ...current.backgroundReview,
              childSessionID: "ses_other",
              promptMessageID: "msg_other",
              stop: "pending" as const,
            },
          },
          result: true,
        }
      })
    } else {
      await harness.services.state.removeOwned(PARENT)
    }
    release.resolve()
    await cancelling

    if (mode === "replacement") {
      const saved = harness.state()?.backgroundReview
      assert.equal(saved?.childSessionID, "ses_other")
      assert.equal(saved?.promptMessageID, "msg_other")
      assert.equal(saved?.stop, "pending")
    } else {
      assert.equal(harness.state(), null)
    }
  }
})

test("cross-instance cancellation fails closed when shared state cannot be read", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()
  const failingServices: StmServices = {
    ...harness.services,
    state: {
      ...harness.services.state,
      load: async () => ({ ok: false, reason: "state: unreadable" }),
    },
  }
  const second = createBackgroundReviewer(failingServices, async () => ({ status: "applied" }))
  t.after(() => second.dispose())

  await second.cancel(PARENT, "manual-lock")
  assert.equal(countCalls(harness, "abort"), 0)
  assert.equal(harness.state()?.backgroundReview?.phase, "active")
})

test("deletion does not stop or rewrite a replacement attempt that lands during revocation", async (t) => {
  const harness = makeHarness()
  t.after(() => harness.reviewer.dispose())
  const second = createBackgroundReviewer(harness.services, async () => ({ status: "applied" }))
  t.after(() => second.dispose())
  await seedPendingReview(harness)
  assert.equal((await harness.reviewer.start(startArgs(), makeContext().context)).status, "queued")
  await harness.waitForPrompt()

  const originalPresent = harness.services.state.updateIfPresent.bind(harness.services.state)
  let injected = false
  harness.services.state.updateIfPresent = async (sessionID, fn) => {
    if (!injected && sessionID === PARENT) {
      injected = true
      const replaced = await originalPresent(sessionID, (current) => {
        if (current.backgroundReview === null) throw new Error("expected stored attempt")
        return {
          next: {
            ...current,
            backgroundReview: {
              ...current.backgroundReview,
              id: "attempt-replacement",
              ownerID: "owner-replacement",
              childSessionID: "ses_replacement",
              promptMessageID: "msg_replacement",
            },
          },
          result: true,
        }
      })
      assert.equal(replaced.ok, true)
    }
    return originalPresent(sessionID, fn)
  }

  await second.onEvent({ type: "session.deleted", properties: { info: { id: PARENT } } })
  assert.equal(injected, true)
  assert.equal(countCalls(harness, "abort"), 0)
  const saved = harness.state()?.backgroundReview
  assert.equal(saved?.id, "attempt-replacement")
  assert.equal(saved?.ownerID, "owner-replacement")
  assert.equal(saved?.childSessionID, "ses_replacement")
  assert.equal(saved?.stop, "pending")
})
