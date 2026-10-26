// test/review-apply.test.ts
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config.js"
import { REVIEW_REVOCATION_REASONS, revokeReview, type BackgroundAttempt } from "../src/background-state.js"
import { applyBackgroundDecision, parseReviewDecision } from "../src/review-apply.js"
import { lockManually, resolveReview, unlock } from "../src/scheduler.js"
import { createOperationGuard, createStateStore, hashTitle, initialMeta, type SessionMeta } from "../src/state.js"
import { createRootCache } from "../src/sdk.js"
import { createTranscriptPager } from "../src/transcript.js"
import type { StmServices } from "../src/tools.js"
import { fakeClient, type FakeHandler, type FakeHandlers } from "./fakes.js"

const PARENT = "ses_parent"
const ATTEMPT_ID = "attempt-1"
const OWNER_ID = "owner-1"
const REVIEW_ID = "review-1"
const OLD_TITLE = "Existing reviewable title"
const NEW_TITLE = "Reviewed replacement title"

const createdDirs: string[] = []

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
})

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function attempt(overrides: Partial<BackgroundAttempt> = {}): BackgroundAttempt {
  return {
    id: ATTEMPT_ID,
    reviewID: REVIEW_ID,
    ownerID: OWNER_ID,
    phase: "active",
    titleDigest: hashTitle(OLD_TITLE),
    cutoffMessageID: "msg_dispatch",
    activityAtDispatch: 20,
    deadline: 10_000,
    childSessionID: "ses_child",
    promptMessageID: "msg_prompt",
    stop: "pending",
    failureCode: null,
    ...overrides,
  }
}

function seededMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    ...initialMeta(),
    activity: 27,
    baselineMessageID: "msg_27",
    frontier: ["msg_1", "msg_27"],
    anchors: [
      {
        reviewID: REVIEW_ID,
        reminderIndex: 0,
        anchorMessageID: "msg_anchor",
        partID: `stm-reminder-${REVIEW_ID}-0`,
        obsolete: false,
      },
    ],
    review: { id: REVIEW_ID, remindersSent: 1, nextTriggerAt: 60 },
    titleDigest: hashTitle(OLD_TITLE),
    backgroundReview: attempt(),
    ...overrides,
  }
}

type Harness = {
  services: StmServices
  calls: Array<{ method: string; options: any }>
  dir: string
  currentTitle: () => string
  setTitle: (value: string) => void
}

function makeHarness(options: { title?: string; handlers?: Partial<FakeHandlers>; now?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "stm-review-apply-"))
  createdDirs.push(dir)
  let title = options.title ?? OLD_TITLE
  let now = options.now ?? 1_000
  const baseHandlers: FakeHandlers = {
    get: async (input: any) => ({ data: { id: input.path.id, title } }),
    update: async (input: any) => {
      title = String(input.body.title)
      return { data: { id: input.path.id, title } }
    },
  }
  const fake = fakeClient({ ...baseHandlers, ...options.handlers })
  const services: StmServices = {
    client: fake.client,
    config: DEFAULT_CONFIG,
    state: createStateStore({ stateDir: dir }),
    transcripts: createTranscriptPager(),
    roots: createRootCache(fake.client),
    guard: createOperationGuard(),
    blocked: new Map(),
    now: () => now,
  }
  return {
    services,
    calls: fake.calls,
    dir,
    currentTitle: () => title,
    setTitle(value) {
      title = value
    },
  }
}

async function seed(harness: Harness, meta: SessionMeta = seededMeta()): Promise<void> {
  const saved = await harness.services.state.save(PARENT, meta)
  assert.equal(saved.ok, true)
}

async function state(harness: Harness): Promise<SessionMeta | null> {
  const loaded = await harness.services.state.load(PARENT)
  assert.equal(loaded.ok, true)
  return loaded.value
}

function writes(harness: Harness): Array<{ method: string; options: any }> {
  return harness.calls.filter((call) => call.method === "update")
}

test("parseReviewDecision accepts only exact keep and rename objects", () => {
  assert.deepEqual(parseReviewDecision({ decision: "keep" }), { ok: true, value: { decision: "keep" } })
  assert.deepEqual(parseReviewDecision({ decision: "rename", title: `  ${NEW_TITLE}  ` }), {
    ok: true,
    value: { decision: "rename", title: NEW_TITLE },
  })
  assert.equal(parseReviewDecision({ decision: "rename", title: "😀".repeat(120) }).ok, true)

  for (const value of [
    null,
    "keep",
    [],
    {},
    { title: NEW_TITLE },
    { decision: "keep", title: NEW_TITLE },
    { decision: "keep", extra: true },
    { decision: "rename" },
    { decision: "rename", title: "" },
    { decision: "rename", title: "   " },
    { decision: "rename", title: 42 },
    { decision: "rename", title: "two\nlines" },
    { decision: "rename", title: "a".repeat(121) },
    { decision: "rename", title: NEW_TITLE, extra: true },
    { decision: "remove", title: NEW_TITLE },
  ]) {
    assert.equal(parseReviewDecision(value).ok, false, JSON.stringify(value))
  }
})

test("keep resolves the exact active attempt atomically and keeps post-dispatch activity", async () => {
  const harness = makeHarness()
  await seed(harness)
  const result = await applyBackgroundDecision(
    harness.services,
    { parentID: PARENT, attemptID: ATTEMPT_ID, ownerID: OWNER_ID, decision: { decision: "keep" } },
    new AbortController().signal,
  )

  assert.deepEqual(result, { status: "applied" })
  assert.equal(writes(harness).length, 0)
  const saved = await state(harness)
  assert.equal(saved?.activity, 7)
  assert.equal(saved?.review, null)
  assert.equal(saved?.backgroundReview, null)
  assert.equal(saved?.titleDigest, hashTitle(OLD_TITLE))
  assert.deepEqual(saved?.frontier, ["msg_1", "msg_27"])
  assert.equal(saved?.anchors.length, 1)
})

test("a rename to the live title resolves as keep without an SDK write", async () => {
  const harness = makeHarness()
  await seed(harness)
  const result = await applyBackgroundDecision(
    harness.services,
    { parentID: PARENT, attemptID: ATTEMPT_ID, ownerID: OWNER_ID, decision: { decision: "rename", title: OLD_TITLE } },
    new AbortController().signal,
  )

  assert.deepEqual(result, { status: "applied" })
  assert.equal(writes(harness).length, 0)
  const saved = await state(harness)
  assert.equal(saved?.activity, 7)
  assert.equal(saved?.review, null)
  assert.equal(saved?.titleDigest, hashTitle(OLD_TITLE))
})

test("rename writes once, reads back, and resolves with the read-back title", async () => {
  const harness = makeHarness()
  await seed(harness)
  const result = await applyBackgroundDecision(
    harness.services,
    {
      parentID: PARENT,
      attemptID: ATTEMPT_ID,
      ownerID: OWNER_ID,
      decision: { decision: "rename", title: NEW_TITLE },
    },
    new AbortController().signal,
  )

  assert.deepEqual(result, { status: "applied" })
  assert.equal(writes(harness).length, 1)
  assert.deepEqual(writes(harness)[0]?.options.body, { title: NEW_TITLE })
  const saved = await state(harness)
  assert.equal(saved?.activity, 7)
  assert.equal(saved?.review, null)
  assert.equal(saved?.backgroundReview, null)
  assert.equal(saved?.titleDigest, hashTitle(NEW_TITLE))
})

test("stale authority discards before any title write or activity loss", async () => {
  const cases: Array<{
    name: string
    meta: SessionMeta
    attemptID?: string
    ownerID?: string
    signal?: AbortSignal
    now?: number
  }> = []

  const base = seededMeta()
  cases.push({ name: "wrong attempt", meta: base, attemptID: "attempt-other" })
  cases.push({ name: "wrong owner", meta: base, ownerID: "owner-other" })
  cases.push({ name: "failed phase", meta: seededMeta({ backgroundReview: attempt({ phase: "failed" }) }) })
  cases.push({ name: "uncertain phase", meta: seededMeta({ backgroundReview: attempt({ phase: "uncertain" }) }) })
  cases.push({ name: "locked", meta: seededMeta({ locked: true, lockReason: "manual" }) })
  cases.push({ name: "missing review", meta: seededMeta({ review: null }) })
  cases.push({
    name: "replaced review",
    meta: seededMeta({ review: { id: "review-new", remindersSent: 1, nextTriggerAt: 60 } }),
  })
  cases.push({ name: "changed state digest", meta: seededMeta({ titleDigest: hashTitle("Changed") }) })
  cases.push({ name: "activity reset", meta: seededMeta({ activity: 19 }) })
  const aborted = new AbortController()
  aborted.abort()
  cases.push({ name: "aborted signal", meta: base, signal: aborted.signal })
  cases.push({ name: "expired deadline", meta: base, now: 10_000 })

  for (const entry of cases) {
    const harness = makeHarness({ now: entry.now })
    await seed(harness, entry.meta)
    const result = await applyBackgroundDecision(
      harness.services,
      {
        parentID: PARENT,
        attemptID: entry.attemptID ?? ATTEMPT_ID,
        ownerID: entry.ownerID ?? OWNER_ID,
        decision: { decision: "rename", title: NEW_TITLE },
      },
      entry.signal ?? new AbortController().signal,
    )
    assert.deepEqual(result, { status: "discarded" }, entry.name)
    assert.equal(writes(harness).length, 0, entry.name)
    assert.equal((await state(harness))?.activity, entry.meta.activity, entry.name)
  }

  const changedTitle = makeHarness({ title: "Changed externally" })
  await seed(changedTitle)
  assert.deepEqual(
    await applyBackgroundDecision(
      changedTitle.services,
      {
        parentID: PARENT,
        attemptID: ATTEMPT_ID,
        ownerID: OWNER_ID,
        decision: { decision: "rename", title: NEW_TITLE },
      },
      new AbortController().signal,
    ),
    { status: "discarded" },
  )
  assert.equal(writes(changedTitle).length, 0)
  assert.equal((await state(changedTitle))?.activity, 27)
})

test("a lock or resolution during the final title read prevents the rename write", async () => {
  for (const change of ["lock", "resolve", "title"] as const) {
    const harness = makeHarness()
    await seed(harness)
    const read = deferred<void>()
    const release = deferred<void>()
    let paused = false
    harness.services.client.session.get = (async (input: any) => {
      if (!paused) {
        paused = true
        read.resolve()
        await release.promise
      }
      return { data: { id: input.path.id, title: harness.currentTitle() } }
    }) as any

    const applying = applyBackgroundDecision(
      harness.services,
      {
        parentID: PARENT,
        attemptID: ATTEMPT_ID,
        ownerID: OWNER_ID,
        decision: { decision: "rename", title: NEW_TITLE },
      },
      new AbortController().signal,
    )
    await read.promise
    if (change === "lock") {
      await harness.services.state.update(PARENT, (current) => ({
        next: lockManually(current ?? initialMeta()),
        result: true,
      }))
    } else if (change === "resolve") {
      await harness.services.state.update(PARENT, (current) => ({
        next: resolveReview(current ?? initialMeta(), hashTitle(OLD_TITLE)),
        result: true,
      }))
    } else {
      harness.setTitle("Changed during the final read")
    }
    release.resolve()

    assert.deepEqual(await applying, { status: "discarded" }, change)
    assert.equal(writes(harness).length, 0, change)
    assert.equal((await state(harness))?.activity, change === "resolve" ? 0 : 27, change)
  }
})

test("a failed or mismatched title write becomes uncertain and is never retried", async () => {
  const failing = makeHarness({ handlers: { update: async () => ({ error: { message: "uncertain" } }) } })
  await seed(failing)
  assert.deepEqual(
    await applyBackgroundDecision(
      failing.services,
      {
        parentID: PARENT,
        attemptID: ATTEMPT_ID,
        ownerID: OWNER_ID,
        decision: { decision: "rename", title: NEW_TITLE },
      },
      new AbortController().signal,
    ),
    { status: "uncertain" },
  )
  assert.equal(writes(failing).length, 1)
  let saved = await state(failing)
  assert.equal(saved?.backgroundReview?.phase, "uncertain")
  assert.equal(saved?.backgroundReview?.failureCode, "background-uncertain-write")
  assert.equal(saved?.review?.id, REVIEW_ID)
  assert.equal(saved?.titleDigest, hashTitle(OLD_TITLE))
  assert.equal(saved?.activity, 27)

  let mismatchedTitle = OLD_TITLE
  const mismatched = makeHarness({
    handlers: {
      get: async (input: any) => ({ data: { id: input.path.id, title: mismatchedTitle } }),
      update: async (input: any) => {
        mismatchedTitle = "Another writer won"
        return { data: { id: input.path.id, title: NEW_TITLE } }
      },
    },
  })
  await seed(mismatched)
  assert.deepEqual(
    await applyBackgroundDecision(
      mismatched.services,
      {
        parentID: PARENT,
        attemptID: ATTEMPT_ID,
        ownerID: OWNER_ID,
        decision: { decision: "rename", title: NEW_TITLE },
      },
      new AbortController().signal,
    ),
    { status: "uncertain" },
  )
  saved = await state(mismatched)
  assert.equal(saved?.backgroundReview?.phase, "uncertain")
  assert.equal(saved?.backgroundReview?.failureCode, "background-uncertain-write")
  assert.equal(writes(mismatched).length, 1)
})

test("abort or deadline expiry during the title write persists uncertainty exactly once", async () => {
  for (const mode of ["abort", "deadline"] as const) {
    const gate = deferred<void>()
    const wrote = deferred<void>()
    let title = OLD_TITLE
    const harness = makeHarness({
      handlers: {
        update: async (input: any) => {
          wrote.resolve()
          await gate.promise
          title = String(input.body.title)
          return { data: { id: input.path.id, title } }
        },
      },
    })
    await seed(harness)
    const controller = new AbortController()
    const applying = applyBackgroundDecision(
      harness.services,
      {
        parentID: PARENT,
        attemptID: ATTEMPT_ID,
        ownerID: OWNER_ID,
        decision: { decision: "rename", title: NEW_TITLE },
      },
      controller.signal,
    )
    await wrote.promise
    if (mode === "abort") controller.abort()
    else harness.services.now = () => 10_001
    gate.resolve()

    assert.deepEqual(await applying, { status: "uncertain" }, mode)
    assert.equal(writes(harness).length, 1, mode)
    const saved = await state(harness)
    assert.equal(saved?.backgroundReview?.phase, "uncertain", mode)
    assert.equal(saved?.backgroundReview?.failureCode, "background-uncertain-write", mode)
    assert.equal(saved?.review?.id, REVIEW_ID, mode)
    assert.equal(saved?.activity, 27, mode)
  }
})

test("a state write failure after a title change is uncertain and preserves prior metadata", async () => {
  const harness = makeHarness()
  await seed(harness)
  const original = harness.services.state.updateIfPresent.bind(harness.services.state)
  let failed = false
  harness.services.state.updateIfPresent = async (sessionID, fn) => {
    if (!failed) {
      failed = true
      return { ok: false, reason: "state: lock contention" }
    }
    return original(sessionID, fn)
  }

  assert.deepEqual(
    await applyBackgroundDecision(
      harness.services,
      {
        parentID: PARENT,
        attemptID: ATTEMPT_ID,
        ownerID: OWNER_ID,
        decision: { decision: "rename", title: NEW_TITLE },
      },
      new AbortController().signal,
    ),
    { status: "uncertain" },
  )
  harness.services.state.updateIfPresent = original
  const saved = await state(harness)
  assert.equal(saved?.backgroundReview?.phase, "uncertain")
  assert.equal(saved?.backgroundReview?.failureCode, "background-uncertain-write")
  assert.equal(saved?.review?.id, REVIEW_ID)
  assert.equal(saved?.activity, 27)
})

test("deleted parent metadata is never recreated after a late write", async () => {
  const wrote = deferred<void>()
  const release = deferred<void>()
  let title = OLD_TITLE
  const harness = makeHarness({
    handlers: {
      update: async (input: any) => {
        wrote.resolve()
        await release.promise
        title = String(input.body.title)
        return { data: { id: input.path.id, title } }
      },
    },
  })
  await seed(harness)

  const applying = applyBackgroundDecision(
    harness.services,
    {
      parentID: PARENT,
      attemptID: ATTEMPT_ID,
      ownerID: OWNER_ID,
      decision: { decision: "rename", title: NEW_TITLE },
    },
    new AbortController().signal,
  )
  await wrote.promise
  await harness.services.state.removeOwned(PARENT)
  release.resolve()

  assert.deepEqual(await applying, { status: "uncertain" })
  assert.equal(writes(harness).length, 1)
  assert.equal(await state(harness), null)
})

test("a late duplicate cannot apply twice or after revocation", async () => {
  const harness = makeHarness()
  await seed(harness)
  const first = await applyBackgroundDecision(
    harness.services,
    {
      parentID: PARENT,
      attemptID: ATTEMPT_ID,
      ownerID: OWNER_ID,
      decision: { decision: "rename", title: NEW_TITLE },
    },
    new AbortController().signal,
  )
  const second = await applyBackgroundDecision(
    harness.services,
    {
      parentID: PARENT,
      attemptID: ATTEMPT_ID,
      ownerID: OWNER_ID,
      decision: { decision: "rename", title: "A second title" },
    },
    new AbortController().signal,
  )
  assert.deepEqual(first, { status: "applied" })
  assert.deepEqual(second, { status: "discarded" })
  assert.equal(writes(harness).length, 1)

  const revoked = makeHarness()
  await seed(revoked)
  await revoked.services.state.update(PARENT, (current) => ({
    next: revokeReview(current ?? initialMeta(), REVIEW_REVOCATION_REASONS.manualLock),
    result: true,
  }))
  assert.deepEqual(
    await applyBackgroundDecision(
      revoked.services,
      {
        parentID: PARENT,
        attemptID: ATTEMPT_ID,
        ownerID: OWNER_ID,
        decision: { decision: "keep" },
      },
      new AbortController().signal,
    ),
    { status: "discarded" },
  )
  assert.equal(writes(revoked).length, 0)
  assert.equal((await state(revoked))?.activity, 27)
})

test("unlock then lock changes during the final read keep the activity baseline intact", async () => {
  const harness = makeHarness()
  await seed(harness)
  await harness.services.state.update(PARENT, (current) => ({
    next: unlock(current ?? initialMeta(), hashTitle(OLD_TITLE)),
    result: true,
  }))
  await harness.services.state.update(PARENT, (current) => ({
    next: lockManually(current ?? initialMeta()),
    result: true,
  }))
  assert.deepEqual(
    await applyBackgroundDecision(
      harness.services,
      {
        parentID: PARENT,
        attemptID: ATTEMPT_ID,
        ownerID: OWNER_ID,
        decision: { decision: "keep" },
      },
      new AbortController().signal,
    ),
    { status: "discarded" },
  )
  assert.equal(writes(harness).length, 0)
  assert.equal((await state(harness))?.activity, 0)
})
