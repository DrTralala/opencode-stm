import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_CONFIG } from "../src/config.js"
import { FRONTIER_MAX, initialMeta, type AnchorState } from "../src/state.js"
import {
  STM_TOOL_NAMES,
  anchorPartID,
  classifyMessages,
  firstObservation,
  isDefaultTitle,
  lockExternal,
  lockManually,
  observe,
  resolveReview,
  unlock,
} from "../src/scheduler.js"
import type { MutableMessage, MutablePart } from "../src/injection.js"

function user(id: string, parts?: MutablePart[]): MutableMessage {
  return {
    info: { id, sessionID: "ses_1", role: "user" },
    parts: parts ?? [{ id: `${id}-p`, type: "text", text: `text ${id}` }],
  }
}

function assistant(id: string, parts: MutablePart[]): MutableMessage {
  return { info: { id, sessionID: "ses_1", role: "assistant" }, parts }
}

const text = (id: string, body: string): MutablePart => ({ id, type: "text", text: body })
const stmTool = (id: string, toolName: string): MutablePart => ({ id, type: "tool", tool: toolName, callID: id })

function observedOf(messages: MutableMessage[]) {
  return classifyMessages(messages)
}

test("eligibility follows the design matrix", () => {
  const summaryUser: MutableMessage = {
    ...user("m-summary"),
    info: { id: "m-summary", sessionID: "ses_1", role: "user", summary: { title: "s" } },
  }
  const summaryAssistant: MutableMessage = {
    ...assistant("m-summary-a", [text("t1", "summary")]),
    info: { id: "m-summary-a", sessionID: "ses_1", role: "assistant", summary: true },
  }
  const syntheticOnly: MutableMessage = assistant("m-synth", [
    { id: "s1", type: "text", text: "housekeeping", synthetic: true },
  ])
  const stmOnly: MutableMessage = assistant("m-stm", [stmTool("t1", STM_TOOL_NAMES[0]!)])
  const mixed: MutableMessage = assistant("m-mixed", [stmTool("t1", STM_TOOL_NAMES[0]!), text("t2", "real work")])
  const nonStmTool: MutableMessage = assistant("m-tool", [stmTool("t1", "bash")])

  const observed = observedOf([user("m-user"), summaryUser, summaryAssistant, syntheticOnly, stmOnly, mixed, nonStmTool])
  assert.deepEqual(
    observed.map((entry) => entry.eligible),
    [true, false, false, false, false, true, true],
  )
})

test("default thresholds open at 20 and anchor reminders at 60 and 140", () => {
  const config = DEFAULT_CONFIG.review
  let meta = initialMeta()
  const deps = { newId: () => "rev-1" }
  const history: MutableMessage[] = [user("m1")]
  let next = 2

  // First observation baselines the visible IDs without counting old history.
  ;({ meta } = observe(meta, observedOf(history), config, deps))
  assert.equal(meta.activity, 0)
  assert.equal(meta.baselineMessageID, "m1")

  const add = (count: number) => {
    for (let index = 0; index < count; index += 1) history.push(user(`m${next++}`))
    return observedOf(history)
  }

  const first = observe(meta, add(19), config, deps)
  assert.equal(first.meta.activity, 19)
  assert.equal(first.anchor, null)

  const open = observe(first.meta, add(1), config, deps)
  assert.equal(open.meta.activity, 20)
  assert.equal(open.meta.review?.id, "rev-1")
  assert.equal(open.meta.review?.remindersSent, 1)
  assert.equal(open.meta.review?.nextTriggerAt, 60)
  assert.equal(open.anchor?.anchorMessageID, "m21")
  assert.equal(open.anchor?.partID, "stm-reminder-rev-1-0")

  const second = observe(open.meta, add(40), config, deps)
  assert.equal(second.meta.activity, 60)
  assert.equal(second.meta.review?.remindersSent, 2)
  assert.equal(second.meta.review?.nextTriggerAt, 140)
  assert.equal(second.anchor?.partID, "stm-reminder-rev-1-1")

  const third = observe(second.meta, add(80), config, deps)
  assert.equal(third.meta.activity, 140)
  assert.equal(third.meta.review?.remindersSent, 3)
  assert.equal(third.anchor?.partID, "stm-reminder-rev-1-2")

  const exhausted = observe(third.meta, add(200), config, deps)
  assert.equal(exhausted.meta.activity, 340)
  assert.equal(exhausted.anchor, null)
  assert.equal(exhausted.meta.review?.remindersSent, 3)
})

test("replayed observations cannot advance activity", () => {
  let meta = initialMeta()
  const config = DEFAULT_CONFIG.review
  const deps = { newId: () => "rev-1" }
  ;({ meta } = observe(meta, observedOf([user("m1")]), config, deps))
  const once = observe(meta, observedOf([user("m1"), user("m2"), user("m3")]), config, deps)
  const twice = observe(once.meta, observedOf([user("m1"), user("m2"), user("m3")]), config, deps)
  assert.equal(once.meta.activity, 2)
  assert.equal(twice.meta.activity, 2)
})

test("a capped frontier does not recount older ids on replay", () => {
  const config = DEFAULT_CONFIG.review
  const deps = { newId: () => "rev-1" }
  let meta = initialMeta()
  const history: MutableMessage[] = Array.from({ length: FRONTIER_MAX + 36 }, (_, index) => user(`m${index + 1}`))
  // First observation baselines the >FRONTIER_MAX visible IDs without counting them.
  ;({ meta } = observe(meta, observedOf(history), config, deps))
  const before = meta.activity
  const replayed = observe(meta, observedOf(history), config, deps)
  assert.equal(replayed.meta.activity, before)
  const advanced = observe(replayed.meta, observedOf([...history, user(`m${FRONTIER_MAX + 37}`)]), config, deps)
  assert.equal(advanced.meta.activity, before + 1)
})

test("a vanished baseline rebaselines without counting visible old messages", () => {
  let meta = firstObservation(true, "digest-1")
  const config = DEFAULT_CONFIG.review
  const deps = { newId: () => "rev-1" }
  const baselined = observe(meta, observedOf([user("a"), assistant("b", [text("t", "hi")])]), config, deps).meta
  const rebaselined = observe(baselined, observedOf([user("x"), user("y")]), config, deps)
  assert.equal(rebaselined.meta.activity, baselined.activity)
  assert.equal(rebaselined.meta.baselineMessageID, "y")
})

test("an unseen summary message rebaselines and preserves review budget", () => {
  let meta = firstObservation(true, "digest-1")
  const config = DEFAULT_CONFIG.review
  const review = { id: "rev-1", remindersSent: 2, nextTriggerAt: 60 }
  meta = { ...meta, activity: 60, review, baselineMessageID: "m5" }
  const summary: MutableMessage = {
    ...user("m-summary"),
    info: { id: "m-summary", sessionID: "ses_1", role: "user", summary: { title: "compact" } },
  }
  const result = observe(meta, observedOf([user("m5"), summary, user("m6")]), config, { newId: () => "rev-2" })
  assert.equal(result.meta.review?.id, "rev-1")
  assert.equal(result.meta.review?.remindersSent, 2)
  assert.equal(result.meta.activity, 60)
})

test("locked metadata suppresses reviews and reminders but still counts activity", () => {
  const config = DEFAULT_CONFIG.review
  const deps = { newId: () => "rev-1" }
  let meta = firstObservation(true, "digest-1")
  meta = observe(meta, observedOf([user("m0")]), config, deps).meta
  meta = lockExternal(meta)
  const observed = observedOf([user("m0"), ...Array.from({ length: 25 }, (_, index) => user(`m${index + 1}`))])
  const result = observe(meta, observed, config, deps)
  assert.equal(result.meta.activity, 25)
  assert.equal(result.meta.review, null)
  assert.equal(result.anchor, null)
})

test("direct title classification and transitions", () => {
  assert.equal(isDefaultTitle("New session - 2026-10-10T12:00:00.000Z"), true)
  assert.equal(isDefaultTitle("Child session - 2026-10-10T12:00:00.000Z"), true)
  assert.equal(isDefaultTitle("My project notes"), false)
  assert.equal(isDefaultTitle("New session - 2026-10-10T12:00:00.000Z "), false)
  assert.equal(anchorPartID("rev-1", 2), "stm-reminder-rev-1-2")

  const lockedNonDefault = firstObservation(false, "digest-ignored")
  assert.equal(lockedNonDefault.locked, true)
  assert.equal(lockedNonDefault.lockReason, "non-default-title")
  assert.equal(lockedNonDefault.titleDigest, null)

  const retainedAnchor: AnchorState = {
    reviewID: "rev-1",
    reminderIndex: 1,
    anchorMessageID: "m9",
    partID: "stm-reminder-rev-1-1",
    obsolete: false,
  }
  const resolved = resolveReview(
    { ...initialMeta(), activity: 30, review: { id: "rev-1", remindersSent: 2, nextTriggerAt: 60 }, anchors: [retainedAnchor] },
    "digest-new",
  )
  assert.equal(resolved.activity, 0)
  assert.equal(resolved.review, null)
  assert.equal(resolved.titleDigest, "digest-new")
  assert.deepEqual(resolved.anchors, [retainedAnchor])

  const unlocked = unlock(
    {
      ...initialMeta(),
      activity: 90,
      locked: true,
      lockReason: "manual",
      review: { id: "rev-1", remindersSent: 3, nextTriggerAt: 300 },
      anchors: [{ ...retainedAnchor, reminderIndex: 2, partID: "stm-reminder-rev-1-2" }],
    },
    "digest-current",
  )
  assert.equal(unlocked.locked, false)
  assert.equal(unlocked.activity, 0)
  assert.equal(unlocked.review, null)
  assert.equal(unlocked.anchors.length, 1)
  assert.equal(unlocked.anchors[0]?.partID, "stm-reminder-rev-1-2")
})

test("several tool calls in one assistant message count once", () => {
  const config = DEFAULT_CONFIG.review
  const deps = { newId: () => "rev-1" }
  let meta = initialMeta()
  meta = observe(meta, observedOf([user("m1")]), config, deps).meta
  const tools = assistant("m-tools", [
    text("t0", "real work"),
    stmTool("t1", "bash"),
    stmTool("t2", "read"),
    stmTool("t3", "edit"),
  ])
  const result = observe(meta, observedOf([user("m1"), tools]), config, deps)
  assert.equal(result.meta.activity, 1)
})

test("assistant reasoning-only message is not eligible", () => {
  const observed = observedOf([assistant("m-reason", [{ id: "r1", type: "reasoning", text: "thinking" }])])
  assert.equal(observed[0]?.eligible, false)
})

test("user message with only synthetic text is not eligible", () => {
  const observed = observedOf([user("m-synth", [{ id: "s1", type: "text", text: "housekeeping", synthetic: true }])])
  assert.equal(observed[0]?.eligible, false)
})

test("user file part is eligible", () => {
  const observed = observedOf([user("m-file", [{ id: "f1", type: "file" }])])
  assert.equal(observed[0]?.eligible, true)
})

test("cfg disabled counts activity but opens no review", () => {
  const config = { ...DEFAULT_CONFIG.review, enabled: false }
  const deps = { newId: () => "rev-1" }
  let meta = initialMeta()
  meta = observe(meta, observedOf([user("m0")]), config, deps).meta
  const history: MutableMessage[] = [user("m0")]
  for (let index = 1; index <= 25; index += 1) history.push(user(`m${index}`))
  const result = observe(meta, observedOf(history), config, deps)
  assert.equal(result.meta.activity, 25)
  assert.equal(result.meta.review, null)
  assert.equal(result.anchor, null)
})

test("anchor marked obsolete when its message is absent", () => {
  const config = DEFAULT_CONFIG.review
  const deps = { newId: () => "rev-1" }
  let meta = firstObservation(true, "digest-1")
  meta = observe(meta, observedOf([user("m1")]), config, deps).meta
  meta = {
    ...meta,
    anchors: [
      { reviewID: "rev-1", reminderIndex: 0, anchorMessageID: "m-old", partID: "stm-reminder-rev-1-0", obsolete: false },
    ],
  }
  const result = observe(meta, observedOf([user("m1")]), config, deps)
  assert.equal(result.meta.anchors[0]?.obsolete, true)
  assert.equal(result.anchor, null)
})

test("next threshold still anchors after an obsolete anchor", () => {
  const config = DEFAULT_CONFIG.review
  const deps = { newId: () => "rev-1" }
  let meta = firstObservation(true, "digest-1")
  meta = {
    ...meta,
    activity: 10,
    baselineMessageID: "m1",
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 20 },
    anchors: [
      { reviewID: "rev-1", reminderIndex: 0, anchorMessageID: "m-old", partID: "stm-reminder-rev-1-0", obsolete: false },
    ],
  }
  const history: MutableMessage[] = [user("m1")]
  for (let index = 2; index <= 11; index += 1) history.push(user(`m${index}`))
  const result = observe(meta, observedOf(history), config, deps)
  assert.equal(result.meta.activity, 20)
  assert.equal(result.meta.review?.remindersSent, 2)
  assert.equal(result.anchor?.partID, "stm-reminder-rev-1-1")
  assert.equal(result.meta.anchors[0]?.obsolete, true)
})

test("frontier cap keeps newest 64", () => {
  const config = DEFAULT_CONFIG.review
  const deps = { newId: () => "rev-1" }
  let meta = initialMeta()
  const history: MutableMessage[] = [user("m0")]
  meta = observe(meta, observedOf(history), config, deps).meta
  for (let index = 1; index <= 100; index += 1) {
    history.push(user(`m${index}`))
    meta = observe(meta, observedOf(history), config, deps).meta
  }
  assert.equal(meta.frontier.length, FRONTIER_MAX)
  assert.equal(meta.activity, 100)
})

test("custom backoff 3 produces 20/80/260", () => {
  const config = { ...DEFAULT_CONFIG.review, backoffMultiplier: 3 }
  const deps = { newId: () => "rev-1" }
  let meta = initialMeta()
  const history: MutableMessage[] = [user("m0")]
  meta = observe(meta, observedOf(history), config, deps).meta
  const triggerCounts: number[] = []
  let seen = 0
  for (let index = 1; index <= 260; index += 1) {
    history.push(user(`m${index}`))
    const result = observe(meta, observedOf(history), config, deps)
    meta = result.meta
    const reminders = meta.review?.remindersSent ?? 0
    if (reminders > seen) {
      triggerCounts.push(meta.activity)
      seen = reminders
    }
  }
  assert.deepEqual(triggerCounts, [20, 80, 260])
})

test("unlock with no review starts a fresh schedule", () => {
  const meta = {
    ...initialMeta(),
    activity: 45,
    locked: true,
    lockReason: "manual" as const,
    titleDigest: "digest-old",
  }
  const unlocked = unlock(meta, "digest-fresh")
  assert.equal(unlocked.review, null)
  assert.equal(unlocked.activity, 0)
  assert.equal(unlocked.locked, false)
  assert.equal(unlocked.titleDigest, "digest-fresh")
})

test("manual lock preserves the title digest", () => {
  const meta = firstObservation(true, "digest-1")
  const locked = lockManually(meta)
  assert.equal(locked.locked, true)
  assert.equal(locked.lockReason, "manual")
  assert.equal(locked.titleDigest, "digest-1")
})

test("unlock discards the pending review so the next review gets a fresh id", () => {
  const config = DEFAULT_CONFIG.review
  let meta = firstObservation(true, "digest-1")
  const history: MutableMessage[] = [user("m1")]
  meta = observe(meta, observedOf(history), config, { newId: () => "rev-1" }).meta
  for (let index = 2; index <= 21; index += 1) history.push(user(`m${index}`))
  const opened = observe(meta, observedOf(history), config, { newId: () => "rev-1" })
  assert.equal(opened.meta.review?.id, "rev-1")
  assert.equal(opened.meta.anchors.length, 1)

  meta = unlock(opened.meta, "digest-fresh")
  assert.equal(meta.review, null)
  assert.equal(meta.anchors.length, 1)
  assert.equal(meta.anchors[0]?.reviewID, "rev-1")

  for (let index = 22; index <= 41; index += 1) history.push(user(`m${index}`))
  const reopened = observe(meta, observedOf(history), config, { newId: () => "rev-2" })
  assert.equal(reopened.meta.review?.id, "rev-2")
  assert.equal(reopened.meta.anchors.length, 2)
  assert.equal(reopened.meta.anchors[0]?.reviewID, "rev-1")
  assert.equal(reopened.meta.anchors[1]?.reviewID, "rev-2")
})

test("an initial jump past thresholds catches up one reminder per observation", () => {
  const config = DEFAULT_CONFIG.review
  const deps = { newId: () => "rev-1" }
  let meta = firstObservation(true, "digest-1")
  const history: MutableMessage[] = [user("m1")]
  meta = observe(meta, observedOf(history), config, deps).meta

  for (let index = 2; index <= 101; index += 1) history.push(user(`m${index}`))
  const jumped = observedOf(history)

  const first = observe(meta, jumped, config, deps)
  assert.equal(first.meta.activity, 100)
  assert.equal(first.meta.review?.remindersSent, 1)
  assert.equal(first.meta.review?.nextTriggerAt, 60)
  assert.equal(first.anchor?.partID, "stm-reminder-rev-1-0")

  // Replays emit at most one reminder each and never recount activity.
  const second = observe(first.meta, jumped, config, deps)
  assert.equal(second.meta.activity, 100)
  assert.equal(second.meta.review?.remindersSent, 2)
  assert.equal(second.meta.review?.nextTriggerAt, 140)
  assert.equal(second.anchor?.partID, "stm-reminder-rev-1-1")

  const held = observe(second.meta, jumped, config, deps)
  assert.equal(held.meta.activity, 100)
  assert.equal(held.meta.review?.remindersSent, 2)
  assert.equal(held.anchor, null)

  // The third cumulative threshold is 140, not 100 + backoff.
  for (let index = 102; index <= 141; index += 1) history.push(user(`m${index}`))
  const third = observe(held.meta, observedOf(history), config, deps)
  assert.equal(third.meta.activity, 140)
  assert.equal(third.meta.review?.remindersSent, 3)
  assert.equal(third.anchor?.partID, "stm-reminder-rev-1-2")

  const exhausted = observe(third.meta, observedOf(history), config, deps)
  assert.equal(exhausted.meta.activity, 140)
  assert.equal(exhausted.meta.review?.remindersSent, 3)
  assert.equal(exhausted.anchor, null)
})

test("a jump after the first reminder catches up one reminder per observation", () => {
  const config = DEFAULT_CONFIG.review
  const deps = { newId: () => "rev-1" }
  let meta = firstObservation(true, "digest-1")
  const history: MutableMessage[] = [user("m1")]
  meta = observe(meta, observedOf(history), config, deps).meta
  for (let index = 2; index <= 21; index += 1) history.push(user(`m${index}`))
  const opened = observe(meta, observedOf(history), config, deps)
  assert.equal(opened.meta.review?.remindersSent, 1)
  assert.equal(opened.meta.review?.nextTriggerAt, 60)

  for (let index = 22; index <= 201; index += 1) history.push(user(`m${index}`))
  const jumped = observedOf(history)

  const second = observe(opened.meta, jumped, config, deps)
  assert.equal(second.meta.activity, 200)
  assert.equal(second.meta.review?.remindersSent, 2)
  assert.equal(second.meta.review?.nextTriggerAt, 140)
  assert.equal(second.anchor?.partID, "stm-reminder-rev-1-1")

  const third = observe(second.meta, jumped, config, deps)
  assert.equal(third.meta.activity, 200)
  assert.equal(third.meta.review?.remindersSent, 3)
  assert.equal(third.meta.review?.nextTriggerAt, 300)
  assert.equal(third.anchor?.partID, "stm-reminder-rev-1-2")

  const exhausted = observe(third.meta, jumped, config, deps)
  assert.equal(exhausted.meta.activity, 200)
  assert.equal(exhausted.meta.review?.remindersSent, 3)
  assert.equal(exhausted.anchor, null)
})

test("a custom-backoff jump keeps configured cumulative thresholds", () => {
  const config = { ...DEFAULT_CONFIG.review, backoffMultiplier: 3 }
  const deps = { newId: () => "rev-1" }
  let meta = firstObservation(true, "digest-1")
  const history: MutableMessage[] = [user("m1")]
  meta = observe(meta, observedOf(history), config, deps).meta
  for (let index = 2; index <= 201; index += 1) history.push(user(`m${index}`))
  const jumped = observedOf(history)

  const first = observe(meta, jumped, config, deps)
  assert.equal(first.meta.activity, 200)
  assert.equal(first.meta.review?.remindersSent, 1)
  assert.equal(first.meta.review?.nextTriggerAt, 80)

  const second = observe(first.meta, jumped, config, deps)
  assert.equal(second.meta.activity, 200)
  assert.equal(second.meta.review?.remindersSent, 2)
  assert.equal(second.meta.review?.nextTriggerAt, 260)

  const held = observe(second.meta, jumped, config, deps)
  assert.equal(held.meta.activity, 200)
  assert.equal(held.meta.review?.remindersSent, 2)
  assert.equal(held.anchor, null)

  for (let index = 202; index <= 261; index += 1) history.push(user(`m${index}`))
  const third = observe(held.meta, observedOf(history), config, deps)
  assert.equal(third.meta.activity, 260)
  assert.equal(third.meta.review?.remindersSent, 3)
  assert.equal(third.anchor?.partID, "stm-reminder-rev-1-2")
})
