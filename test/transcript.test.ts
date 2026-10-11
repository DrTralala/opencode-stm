// test/transcript.test.ts
import { getEventListeners } from "node:events"
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CHUNK_BYTES,
  QUEUE_MAX_CALLERS,
  QUEUE_TTL_MS,
  createTranscriptQueue,
  extractVisibleText,
  splitUtf8,
} from "../src/transcript.js"
import type { BeginInput, TranscriptQueue } from "../src/transcript.js"
import type { PageMessage } from "../src/sdk.js"

const pageMessage = (id: string, role: string, parts: Array<Record<string, unknown>>, summary?: unknown): PageMessage => ({
  info: summary === undefined ? { id, sessionID: "ses_hist", role } : { id, sessionID: "ses_hist", role, summary },
  parts,
})

const beginToken = (queue: TranscriptQueue, input: BeginInput, now: number): string => {
  const result = queue.begin(input, now)
  if (!result.ok) assert.fail(result.reason)
  return result.token
}

test("extractVisibleText keeps only non-synthetic user/assistant text", () => {
  const entries = extractVisibleText([
    pageMessage("m1", "user", [{ type: "text", text: "hello" }]),
    pageMessage("m2", "assistant", [
      { type: "reasoning", text: "thinking" },
      { type: "tool", tool: "bash", state: {} },
      { type: "text", text: "answer", synthetic: false },
    ]),
    pageMessage("m3", "assistant", [{ type: "text", text: "injected", synthetic: true }]),
    pageMessage("m4", "user", [{ type: "text", text: "summary" }], { title: "s" }),
    pageMessage("m5", "system", [{ type: "text", text: "system" }]),
    pageMessage("m6", "assistant", [{ type: "text", text: "ignored", ignored: true }]),
  ])
  assert.deepEqual(entries, [
    { messageID: "m1", text: "hello" },
    { messageID: "m2", text: "answer" },
  ])
})

test("multiple text parts in one page keep chronological order", () => {
  const entries = extractVisibleText([
    pageMessage("m1", "user", [{ type: "text", text: "first" }]),
    pageMessage("m2", "assistant", [
      { type: "text", text: "second" },
      { type: "text", text: "third" },
    ]),
  ])
  assert.deepEqual(entries, [
    { messageID: "m1", text: "first" },
    { messageID: "m2", text: "second" },
    { messageID: "m2", text: "third" },
  ])
})

test("splitUtf8 does not split multi-byte code points", () => {
  const ascii = "a".repeat(CHUNK_BYTES + 10)
  const split = splitUtf8(ascii)
  assert.equal(Buffer.byteLength(split.chunk, "utf8"), CHUNK_BYTES)
  assert.equal(split.rest.length, 10)

  const euro = "a".repeat(CHUNK_BYTES - 1) + "€" + "b"
  const euroSplit = splitUtf8(euro)
  assert.equal(euroSplit.chunk.endsWith("€"), false)
  assert.equal(euroSplit.chunk.endsWith("a"), true)
  assert.equal(euroSplit.rest.startsWith("€"), true)

  const emoji = "x".repeat(CHUNK_BYTES - 2) + "😀"
  const emojiSplit = splitUtf8(emoji)
  assert.equal(emojiSplit.rest, "😀")
  assert.throws(() => splitUtf8("abc", 3), RangeError)
})

test("queue enforces one delivered page chunk at a time and cursor binding", () => {
  const queue = createTranscriptQueue()
  const beginOne = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", cursor: undefined },
    0,
  )
  assert.equal(beginOne.ok, true)
  if (!beginOne.ok) return
  assert.equal(beginOne.fetchCursor, undefined)

  const supplied = queue.supply("ses_call", { entries: [{ messageID: "m1", text: "hello" }], nextCursor: "cursor-2" }, 0, beginOne.token)
  assert.equal(supplied.ok, true)
  assert.equal(supplied.ok && supplied.ack.bytes, 5)
  assert.equal(supplied.ok && supplied.ack.cursor, "cursor-2")
  assert.equal(supplied.ok && supplied.ack.complete, false)

  // A second fetch is rejected while a chunk is pending.
  assert.equal(
    queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", cursor: "cursor-2" },
      0,
    ).ok,
    false,
  )

  const pending = queue.take("ses_call", 0)
  assert.equal(pending?.text, "hello")
  assert.equal(pending?.requestMessageID, "msg_tool")
  assert.equal(queue.take("ses_call", 0), null, "take is one-shot")

  const beginTwo = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2", cursor: "cursor-2" },
    1,
  )
  assert.equal(beginTwo.ok, true)
  if (!beginTwo.ok) return
  assert.equal(beginTwo.fetchCursor, "cursor-2")

  const last = queue.supply("ses_call", { entries: [{ messageID: "m2", text: "world" }], nextCursor: null }, 1, beginTwo.token)
  assert.equal(last.ok && last.ack.complete, true)
  assert.equal(
    queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_3", cursor: undefined },
      2,
    ).ok,
    false,
  )
})

test("pending chunks expire after 60 seconds and require an explicit end and restart", () => {
  const queue = createTranscriptQueue()
  const token = beginToken(
    queue,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", cursor: undefined },
    0,
  )
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" }, 0, token)
  assert.equal(queue.take("ses_call", QUEUE_TTL_MS + 1), null)
  // The expired chunk is unrecoverable: a continuation must fail closed instead
  // of silently skipping the lost content.
  const expired = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", cursor: "cursor-2" },
    QUEUE_TTL_MS + 1,
  )
  assert.equal(expired.ok, false)
  if (!expired.ok) assert.match(expired.reason, /expired/)
  // An explicit end releases the binding and the restart refetches from the first page.
  assert.equal(queue.endReview("ses_call", "ses_hist").ok, true)
  const restarted = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2" },
    QUEUE_TTL_MS + 1,
  )
  assert.equal(restarted.ok, true)
  if (restarted.ok) assert.equal(restarted.fetchCursor, undefined)
})

test("expiry is lazy and requires no timer", () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalSetInterval = globalThis.setInterval
  let scheduled = 0
  globalThis.setTimeout = ((...args: Parameters<typeof originalSetTimeout>) => {
    scheduled += 1
    return originalSetTimeout(...args)
  }) as unknown as typeof setTimeout
  globalThis.setInterval = ((...args: Parameters<typeof originalSetInterval>) => {
    scheduled += 1
    return originalSetInterval(...args)
  }) as unknown as typeof setInterval
  try {
    const queue = createTranscriptQueue({ ttlMs: 100 })
    const firstToken = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" }, 0)
    queue.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" }, 0, firstToken)
    assert.equal(queue.take("ses_call", 99)?.text, "body", "eligible before the deadline")
    const second = queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2", cursor: "cursor-2" },
      99,
    )
    assert.equal(second.ok, true)
    if (!second.ok) return
    queue.supply("ses_call", { entries: [{ messageID: "m2", text: "older" }], nextCursor: "cursor-3" }, 99, second.token)
    assert.equal(queue.take("ses_call", 199), null, "the deadline is observed lazily on the next access")
    const expired = queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_3", cursor: "cursor-3" },
      199,
    )
    assert.equal(expired.ok, false, "an expired chunk must be restarted, not continued")
    if (!expired.ok) assert.match(expired.reason, /expired/)
    assert.equal(queue.endReview("ses_call", "ses_hist").ok, true)
    assert.equal(
      queue.begin(
        { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_4" },
        199,
      ).ok,
      true,
      "an explicit end allows a fresh restart from the first page",
    )
    assert.equal(scheduled, 0, "no timer was scheduled")
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.setInterval = originalSetInterval
  }
})

test("expired entries for other callers are swept on the next begin", () => {
  const queue = createTranscriptQueue()
  const controller = new AbortController()
  const tokenA = beginToken(queue, { callerSessionID: "ses_a", targetSessionID: "ses_hist", requestMessageID: "msg_a" }, 0)
  queue.supply("ses_a", { entries: [{ messageID: "m1", text: "a" }], nextCursor: "cursor-a" }, 0, tokenA)
  const tokenB = beginToken(
    queue,
    { callerSessionID: "ses_b", targetSessionID: "ses_hist", requestMessageID: "msg_b", signal: controller.signal },
    0,
  )
  queue.supply("ses_b", { entries: [{ messageID: "m2", text: "b" }], nextCursor: "cursor-b" }, 0, tokenB)
  assert.equal(getEventListeners(controller.signal, "abort").length, 1)

  const deadline = QUEUE_TTL_MS + 1
  const expiredA = queue.begin(
    { callerSessionID: "ses_a", targetSessionID: "ses_hist", requestMessageID: "msg_a_2", cursor: "cursor-a" },
    deadline,
  )
  assert.equal(expiredA.ok, false, "caller A's expired chunk must be restarted, not continued")
  if (!expiredA.ok) assert.match(expiredA.reason, /expired/)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0, "caller B was swept without its own operation")
  assert.equal(queue.take("ses_b", deadline), null, "caller B's expired chunk is already ineligible")
  assert.equal(queue.endReview("ses_a", "ses_hist").ok, true)
})

test("partial-page expiry requires an explicit end and never skips the undelivered remainder", () => {
  const queue = createTranscriptQueue()
  const token = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" }, 0)
  // One oversized entry: the first 16 KiB chunk goes pending and is never taken.
  queue.supply(
    "ses_call",
    { entries: [{ messageID: "m1", text: "a".repeat(CHUNK_BYTES + 5) }], nextCursor: null },
    0,
    token,
  )
  const deadline = QUEUE_TTL_MS + 1
  assert.equal(queue.take("ses_call", deadline), null, "the pending chunk expired undelivered")
  assert.equal(
    queue.begin({ callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2" }, deadline).ok,
    false,
    "a mid-page continuation must not silently skip the lost remainder",
  )
  assert.equal(
    queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2", cursor: "cursor-2" },
      deadline,
    ).ok,
    false,
    "no cursor path may continue an expired binding",
  )
  // An explicit end releases the binding; the restart refetches from the first page.
  assert.equal(queue.endReview("ses_call", "ses_hist").ok, true)
  const restarted = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_3" }, deadline)
  const redelivered = queue.supply(
    "ses_call",
    { entries: [{ messageID: "m1", text: "a".repeat(CHUNK_BYTES + 5) }], nextCursor: null },
    deadline,
    restarted,
  )
  assert.equal(redelivered.ok && redelivered.ack.bytes, CHUNK_BYTES, "the restart refetches the same content")
})

test("whole-page expiry is never labelled complete and requires a restart", () => {
  const queue = createTranscriptQueue()
  const token = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" }, 0)
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "final page" }], nextCursor: null }, 0, token)
  const deadline = QUEUE_TTL_MS + 1
  assert.equal(queue.take("ses_call", deadline), null, "the last chunk expired undelivered")
  const expiredEnd = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2" },
    deadline,
  )
  assert.equal(expiredEnd.ok, false, "an expired last chunk must not be reported as the end of history")
  if (!expiredEnd.ok) assert.match(expiredEnd.reason, /expired/)
  assert.equal(queue.endReview("ses_call", "ses_hist").ok, true)

  // A multi-page expiry is likewise rejected even with the issued continuation cursor.
  const multi = createTranscriptQueue()
  const multiToken = beginToken(multi, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" }, 0)
  multi.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" }, 0, multiToken)
  const continued = multi.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2", cursor: "cursor-2" },
    QUEUE_TTL_MS + 1,
  )
  assert.equal(continued.ok, false, "the expired whole page must not advance to the next page")
  if (!continued.ok) assert.match(continued.reason, /expired/)
  assert.equal(multi.endReview("ses_call", "ses_hist").ok, true)
  const restarted = beginToken(multi, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_3" }, QUEUE_TTL_MS + 1)
  const redelivered = multi.supply(
    "ses_call",
    { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" },
    QUEUE_TTL_MS + 1,
    restarted,
  )
  assert.equal(redelivered.ok && redelivered.ack.complete, false, "the restarted review redelivers before completion")
})

test("queue rejects foreign cursors, target switches and overflow", () => {
  const queue = createTranscriptQueue()
  assert.equal(
    queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", cursor: "foreign" },
      0,
    ).ok,
    false,
  )
  queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", cursor: undefined },
    0,
  )
  assert.equal(
    queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_other", requestMessageID: "msg_tool", cursor: undefined },
      0,
    ).ok,
    false,
  )
  for (let index = 1; index < QUEUE_MAX_CALLERS; index += 1) {
    assert.equal(
      queue.begin(
        { callerSessionID: `ses_${index}`, targetSessionID: "ses_hist", requestMessageID: "msg_tool", cursor: undefined },
        0,
      ).ok,
      true,
    )
  }
  assert.equal(
    queue.begin(
      { callerSessionID: "ses_over", targetSessionID: "ses_hist", requestMessageID: "msg_tool", cursor: undefined },
      0,
    ).ok,
    false,
  )
  queue.endReview("ses_call", "ses_hist")
  assert.equal(queue.has("ses_call"), false)
})

test("each caller has an independent buffer", () => {
  const queue = createTranscriptQueue()
  const tokenA = beginToken(queue, { callerSessionID: "ses_a", targetSessionID: "ses_hist", requestMessageID: "msg_a" }, 0)
  const tokenB = beginToken(queue, { callerSessionID: "ses_b", targetSessionID: "ses_hist", requestMessageID: "msg_b" }, 0)
  queue.supply("ses_a", { entries: [{ messageID: "m1", text: "alpha" }], nextCursor: null }, 0, tokenA)
  queue.supply("ses_b", { entries: [{ messageID: "m2", text: "beta" }], nextCursor: null }, 0, tokenB)
  assert.equal(queue.take("ses_a", 0)?.text, "alpha")
  assert.equal(queue.take("ses_b", 0)?.text, "beta")
})

test("take after release drops the chunk", () => {
  const queue = createTranscriptQueue()
  const token = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" }, 0)
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" }, 0, token)
  assert.equal(queue.release("ses_call", token), true)
  assert.equal(queue.take("ses_call", 0), null)
  assert.equal(
    queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2", cursor: "cursor-2" },
      1,
    ).ok,
    true,
  )
})

test("oversized text continues on the same page via byte offset", () => {
  const queue = createTranscriptQueue()
  const text = "a".repeat(CHUNK_BYTES + 5)
  const token = beginToken(
    queue,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", cursor: undefined },
    0,
  )
  const first = queue.supply("ses_call", { entries: [{ messageID: "m1", text }], nextCursor: null }, 0, token)
  assert.equal(first.ok && first.ack.bytes, CHUNK_BYTES)
  assert.equal(first.ok && first.ack.cursor, null)
  assert.equal(queue.take("ses_call", 0)?.text.length, CHUNK_BYTES)
  const resume = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2", cursor: undefined },
    1,
  )
  assert.equal(resume.ok, true)
  if (!resume.ok) return
  assert.equal(resume.fetchCursor, undefined)
  const second = queue.supply("ses_call", { entries: [{ messageID: "m1", text }], nextCursor: null }, 1, resume.token)
  assert.equal(second.ok && second.ack.bytes, 5)
  assert.equal(second.ok && second.ack.complete, true)
})

test("same-page continuation reports continuation true", () => {
  const queue = createTranscriptQueue()
  const text = "a".repeat(CHUNK_BYTES + 5)
  const token = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" }, 0)
  const first = queue.supply("ses_call", { entries: [{ messageID: "m1", text }], nextCursor: null }, 0, token)
  assert.equal(first.ok && first.ack.continuation, true)
  assert.equal(first.ok && first.ack.bytes, CHUNK_BYTES)
  assert.equal(queue.take("ses_call", 0)?.text.length, CHUNK_BYTES)
})

test("byte offsets are safe across multi-byte code points", () => {
  const queue = createTranscriptQueue()
  const text = "a".repeat(CHUNK_BYTES - 1) + "€" + "b"
  const token = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" }, 0)
  const first = queue.supply("ses_call", { entries: [{ messageID: "m1", text }], nextCursor: null }, 0, token)
  assert.equal(first.ok && first.ack.bytes, CHUNK_BYTES - 1, "the cut backs off to the previous code point")
  const firstChunk = queue.take("ses_call", 0)
  assert.equal(firstChunk?.text.endsWith("€"), false, "a code point is never split")
  assert.equal(firstChunk?.text.endsWith("a"), true)
  const resume = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2" },
    1,
  )
  assert.equal(resume.ok, true)
  if (!resume.ok) return
  const second = queue.supply("ses_call", { entries: [{ messageID: "m1", text }], nextCursor: null }, 1, resume.token)
  assert.equal(second.ok && second.ack.bytes, 4, "€ plus b")
  assert.equal(second.ok && second.ack.complete, true)
  const secondChunk = queue.take("ses_call", 1)
  assert.equal(secondChunk?.text, "€b")
  assert.equal((firstChunk?.text ?? "") + (secondChunk?.text ?? ""), text, "no content lost or duplicated")
})

// Pre-handoff (in-flight) abort: the tool has not committed the chunk yet, so
// aborting still releases the pending text and invalidates the binding.
test("pre-handoff abort releases pending once and prevents later queuing", () => {
  const queue = createTranscriptQueue()
  const controller = new AbortController()
  const token = beginToken(
    queue,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", signal: controller.signal },
    0,
  )
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" }, 0, token)
  controller.abort()
  assert.equal(queue.take("ses_call", 0), null, "abort clears the pending chunk")
  assert.equal(
    queue.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" }, 1, token).ok,
    false,
    "an aborted caller cannot queue text later",
  )
  assert.equal(
    queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", signal: controller.signal },
      2,
    ).ok,
    false,
    "begin with an already-aborted signal is rejected",
  )

  const preAborted = new AbortController()
  preAborted.abort()
  const other = createTranscriptQueue()
  assert.equal(
    other.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", signal: preAborted.signal },
      0,
    ).ok,
    false,
  )
  assert.equal(other.size(), 0, "abort before begin creates no caller state")
})

test("handoff commits a queued chunk: post-success abort keeps it for exactly one take", () => {
  const queue = createTranscriptQueue()
  const controller = new AbortController()
  const token = beginToken(
    queue,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", signal: controller.signal },
    0,
  )
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" }, 0, token)
  assert.equal(queue.handoff("ses_call", token).ok, true)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0, "the handoff detaches the success signal")

  // OpenCode 1.18.35 aborts the per-tool signal shortly after a successful return.
  controller.abort()
  assert.equal(queue.has("ses_call"), true, "the committed binding survives the host abort")
  const delivered = queue.take("ses_call", 0)
  assert.equal(delivered?.text, "body")
  assert.equal(queue.take("ses_call", 0), null, "delivery is still one-shot")
})

test("handoff then abort still allows cursor continuation on the next fetch", () => {
  const queue = createTranscriptQueue()
  const completed = new AbortController()
  const token = beginToken(
    queue,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", signal: completed.signal },
    0,
  )
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "newest" }], nextCursor: "cursor-2" }, 0, token)
  assert.equal(queue.handoff("ses_call", token).ok, true)
  completed.abort()
  assert.equal(queue.take("ses_call", 0)?.text, "newest")

  const next = queue.begin(
    {
      callerSessionID: "ses_call",
      targetSessionID: "ses_hist",
      requestMessageID: "msg_tool_2",
      cursor: "cursor-2",
      signal: new AbortController().signal,
    },
    1,
  )
  assert.equal(next.ok, true)
  if (!next.ok) return
  assert.equal(next.fetchCursor, "cursor-2")
  assert.equal(
    queue.supply("ses_call", { entries: [{ messageID: "m0", text: "older" }], nextCursor: null }, 1, next.token).ok,
    true,
  )
})

test("a stale handoff cannot detach a newer generation or drop its pending chunk", () => {
  const queue = createTranscriptQueue()
  const first = new AbortController()
  const second = new AbortController()
  const begunOne = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_1", signal: first.signal },
    0,
  )
  assert.equal(begunOne.ok, true)
  if (!begunOne.ok) return
  const begunTwo = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2", signal: second.signal },
    0,
  )
  assert.equal(begunTwo.ok, true)
  if (!begunTwo.ok) return
  assert.equal(
    queue.supply("ses_call", { entries: [{ messageID: "m2", text: "current" }], nextCursor: null }, 0, begunTwo.token).ok,
    true,
  )

  const stale = queue.handoff("ses_call", begunOne.token)
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.match(stale.reason, /stale request/)
  assert.equal(getEventListeners(second.signal, "abort").length, 1, "the current listener is untouched")
  const pending = queue.take("ses_call", 0)
  assert.equal(pending?.text, "current")
  assert.equal(pending?.requestMessageID, "msg_tool_2")
})

test("handoff without a queued chunk fails closed and keeps the abort listener", () => {
  const queue = createTranscriptQueue()
  const controller = new AbortController()
  const token = beginToken(
    queue,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", signal: controller.signal },
    0,
  )
  const refused = queue.handoff("ses_call", token)
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.reason, /no pending chunk/)
  assert.equal(getEventListeners(controller.signal, "abort").length, 1, "no unprotection without a chunk")
  controller.abort()
  assert.equal(queue.has("ses_call"), false, "an in-flight abort still invalidates the binding")
})

test("post-handoff cleanup keeps take, lazy expiry, endReview, discard and dispose effective", () => {
  // Lazy TTL expiry still applies to a committed chunk without any timer.
  const expiring = createTranscriptQueue({ ttlMs: 100 })
  const expiryController = new AbortController()
  const expiryToken = beginToken(
    expiring,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", signal: expiryController.signal },
    0,
  )
  expiring.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: null }, 0, expiryToken)
  assert.equal(expiring.handoff("ses_call", expiryToken).ok, true)
  assert.equal(expiring.take("ses_call", 100), null, "the 60 s eligibility deadline still applies after handoff")
  assert.equal(getEventListeners(expiryController.signal, "abort").length, 0)

  // endReview still discards a committed chunk for the matching target.
  const reviewed = createTranscriptQueue()
  const reviewToken = beginToken(
    reviewed,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" },
    0,
  )
  reviewed.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: null }, 0, reviewToken)
  assert.equal(reviewed.handoff("ses_call", reviewToken).ok, true)
  assert.equal(reviewed.endReview("ses_call", "ses_hist").ok, true)
  assert.equal(reviewed.take("ses_call", 0), null)
  assert.equal(reviewed.has("ses_call"), false)

  // discardCaller and dispose still clear a committed binding.
  const discarded = createTranscriptQueue()
  const discardToken = beginToken(
    discarded,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" },
    0,
  )
  discarded.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: null }, 0, discardToken)
  assert.equal(discarded.handoff("ses_call", discardToken).ok, true)
  discarded.discardCaller("ses_call")
  assert.equal(discarded.take("ses_call", 0), null)

  const disposed = createTranscriptQueue()
  const disposeToken = beginToken(
    disposed,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" },
    0,
  )
  disposed.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: null }, 0, disposeToken)
  assert.equal(disposed.handoff("ses_call", disposeToken).ok, true)
  disposed.dispose()
  assert.equal(disposed.size(), 0)
  assert.equal(disposed.take("ses_call", 0), null)
})

test("observed expiry releases abort listeners for swept callers", () => {
  const queue = createTranscriptQueue()
  const controller = new AbortController()
  const token = beginToken(
    queue,
    { callerSessionID: "ses_first", targetSessionID: "ses_hist", requestMessageID: "msg_first", signal: controller.signal },
    0,
  )
  queue.supply("ses_first", { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" }, 0, token)
  assert.equal(getEventListeners(controller.signal, "abort").length, 1)
  queue.begin({ callerSessionID: "ses_second", targetSessionID: "ses_hist", requestMessageID: "msg_second" }, QUEUE_TTL_MS + 1)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
  assert.equal(queue.take("ses_first", QUEUE_TTL_MS + 1), null)
})

test("abort after take deregisters the listener", () => {
  const queue = createTranscriptQueue()
  const controller = new AbortController()
  const token = beginToken(
    queue,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", signal: controller.signal },
    0,
  )
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" }, 0, token)
  assert.equal(queue.take("ses_call", 0)?.text, "body")
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
  controller.abort()
  assert.equal(queue.has("ses_call"), true, "the stale signal cannot drop the binding after delivery")

  const replacement = new AbortController()
  assert.equal(
    queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2", cursor: "cursor-2", signal: replacement.signal },
      1,
    ).ok,
    true,
  )
  assert.equal(getEventListeners(replacement.signal, "abort").length, 1, "a later begin re-attaches")
  replacement.abort()
  assert.equal(queue.has("ses_call"), false)
})

test("begin with a new signal replaces the old listener", () => {
  const queue = createTranscriptQueue()
  const first = new AbortController()
  const second = new AbortController()
  const firstToken = beginToken(
    queue,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", signal: first.signal },
    0,
  )
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "first" }], nextCursor: "cursor-2" }, 0, firstToken)
  assert.equal(queue.take("ses_call", 0)?.text, "first")
  const replacement = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2", cursor: "cursor-2", signal: second.signal },
    1,
  )
  assert.equal(replacement.ok, true)
  if (!replacement.ok) return
  queue.supply("ses_call", { entries: [{ messageID: "m2", text: "second" }], nextCursor: null }, 1, replacement.token)
  assert.equal(getEventListeners(first.signal, "abort").length, 0, "the old listener was replaced")
  first.abort()
  assert.equal(queue.take("ses_call", 1)?.text, "second", "the stale signal did not clear the new chunk")
})

test("overlapping begin issues a fresh token; stale supply and release cannot touch the current pending", () => {
  const queue = createTranscriptQueue()
  const first = new AbortController()
  const second = new AbortController()
  const begunOne = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_1", signal: first.signal },
    0,
  )
  assert.equal(begunOne.ok, true)
  if (!begunOne.ok) return
  const begunTwo = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2", signal: second.signal },
    0,
  )
  assert.equal(begunTwo.ok, true)
  if (!begunTwo.ok) return
  assert.notEqual(begunOne.token, begunTwo.token, "each fetch owns its own generation")

  // The first fetch resolves late: its response must not enter the second binding.
  const late = queue.supply("ses_call", { entries: [{ messageID: "m1", text: "late" }], nextCursor: null }, 0, begunOne.token)
  assert.equal(late.ok, false)
  if (!late.ok) assert.match(late.reason, /stale request/)

  const current = queue.supply(
    "ses_call",
    { entries: [{ messageID: "m2", text: "current" }], nextCursor: "cursor-2" },
    0,
    begunTwo.token,
  )
  assert.equal(current.ok, true)

  // A stale response arriving while the current chunk is pending is rejected and
  // leaves the current chunk untouched; a stale release is a no-op.
  assert.equal(
    queue.supply("ses_call", { entries: [{ messageID: "m1", text: "late" }], nextCursor: null }, 0, begunOne.token).ok,
    false,
  )
  assert.equal(queue.release("ses_call", begunOne.token), false, "a stale release is a no-op")

  // The replaced signal is inert: aborting it cannot clear the current binding.
  first.abort()
  assert.equal(queue.has("ses_call"), true)
  const pending = queue.take("ses_call", 0)
  assert.equal(pending?.text, "current")
  assert.equal(pending?.requestMessageID, "msg_tool_2")

  // Delivery ended that fetch attempt: its token stays stale until a new begin.
  assert.equal(
    queue.supply("ses_call", { entries: [{ messageID: "m2", text: "current" }], nextCursor: "cursor-2" }, 1, begunTwo.token).ok,
    false,
  )
  assert.equal(
    queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_3", cursor: "cursor-2" },
      1,
    ).ok,
    true,
  )
  second.abort()
  assert.equal(queue.has("ses_call"), true, "the delivered request signal is detached")
  queue.endReview("ses_call", "ses_hist")
})

test("abort then restart rejects late supply and release from the aborted generation", () => {
  const queue = createTranscriptQueue()
  const controller = new AbortController()
  const aborted = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_1", signal: controller.signal },
    0,
  )
  assert.equal(aborted.ok, true)
  if (!aborted.ok) return
  controller.abort()
  assert.equal(queue.has("ses_call"), false)

  const restarted = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2" },
    1,
  )
  assert.equal(restarted.ok, true)
  if (!restarted.ok) return
  assert.notEqual(restarted.token, aborted.token)

  assert.equal(
    queue.supply("ses_call", { entries: [{ messageID: "m1", text: "aborted" }], nextCursor: null }, 1, aborted.token).ok,
    false,
    "the aborted generation cannot supply after a restart",
  )
  assert.equal(queue.release("ses_call", aborted.token), false)

  const current = queue.supply(
    "ses_call",
    { entries: [{ messageID: "m2", text: "restart" }], nextCursor: null },
    1,
    restarted.token,
  )
  assert.equal(current.ok, true)
  assert.equal(queue.release("ses_call", aborted.token), false, "the late release still cannot clear the current chunk")
  assert.equal(queue.take("ses_call", 1)?.text, "restart")
})

test("same-page insertion or edit fails closed and resets the binding", () => {
  const queue = createTranscriptQueue()
  const base = "a".repeat(CHUNK_BYTES + 5)
  const token = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" }, 0)
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: base }], nextCursor: "cursor-2" }, 0, token)
  assert.equal(queue.take("ses_call", 0)?.text.length, CHUNK_BYTES)

  // The same newest page changed between chunks: new messages or edited text.
  const resume = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2" },
    1,
  )
  assert.equal(resume.ok, true)
  if (!resume.ok) return
  const changed = "b".repeat(CHUNK_BYTES + 5)
  const supplied = queue.supply("ses_call", { entries: [{ messageID: "m1", text: changed }], nextCursor: "cursor-2" }, 1, resume.token)
  assert.equal(supplied.ok, false)
  if (supplied.ok) return
  assert.match(supplied.reason, /page changed/)
  assert.equal(queue.has("ses_call"), false, "the binding is reset")

  // An explicit restart with no cursor is required and works.
  assert.equal(
    queue.begin({ callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_3" }, 2).ok,
    true,
  )
})

test("digest mismatch on an inserted message fails closed", () => {
  const queue = createTranscriptQueue()
  const base = "a".repeat(CHUNK_BYTES + 5)
  const token = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" }, 0)
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: base }], nextCursor: "cursor-2" }, 0, token)
  assert.equal(queue.take("ses_call", 0)?.text.length, CHUNK_BYTES)
  const resume = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2" },
    1,
  )
  assert.equal(resume.ok, true)
  if (!resume.ok) return
  const inserted = [
    { messageID: "m0", text: "newest" },
    { messageID: "m1", text: base },
  ]
  const supplied = queue.supply("ses_call", { entries: inserted, nextCursor: "cursor-2" }, 1, resume.token)
  assert.equal(supplied.ok, false)
  if (supplied.ok) return
  assert.match(supplied.reason, /page changed/)
  assert.equal(queue.has("ses_call"), false, "the binding is reset")
  assert.equal(queue.take("ses_call", 1), null, "no chunk was queued from the changed page")
  assert.equal(
    queue.begin({ callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_3" }, 2).ok,
    true,
    "an explicit restart with no cursor works",
  )
})

test("page digest distinguishes a null cursor from the literal cursor end in both directions", () => {
  const base = "a".repeat(CHUNK_BYTES + 5)

  const nullFirst = createTranscriptQueue()
  const nullToken = beginToken(nullFirst, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" }, 0)
  assert.equal(nullFirst.supply("ses_call", { entries: [{ messageID: "m1", text: base }], nextCursor: null }, 0, nullToken).ok, true)
  assert.equal(nullFirst.take("ses_call", 0)?.text.length, CHUNK_BYTES)
  const nullResume = beginToken(nullFirst, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2" }, 1)
  const forward = nullFirst.supply("ses_call", { entries: [{ messageID: "m1", text: base }], nextCursor: "end" }, 1, nullResume)
  assert.equal(forward.ok, false, "null must not hash the same as the literal cursor end")
  if (!forward.ok) assert.match(forward.reason, /page changed/)
  assert.equal(nullFirst.has("ses_call"), false, "the binding is reset")

  const endFirst = createTranscriptQueue()
  const endToken = beginToken(endFirst, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" }, 0)
  assert.equal(endFirst.supply("ses_call", { entries: [{ messageID: "m1", text: base }], nextCursor: "end" }, 0, endToken).ok, true)
  assert.equal(endFirst.take("ses_call", 0)?.text.length, CHUNK_BYTES)
  const endResume = beginToken(endFirst, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2" }, 1)
  const reverse = endFirst.supply("ses_call", { entries: [{ messageID: "m1", text: base }], nextCursor: null }, 1, endResume)
  assert.equal(reverse.ok, false, "the literal cursor end must not hash the same as null")
  if (!reverse.ok) assert.match(reverse.reason, /page changed/)
})

test("a consumed page requires the issued cursor on the next fetch", () => {
  const queue = createTranscriptQueue()
  const token = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool" }, 0)
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" }, 0, token)
  queue.take("ses_call", 0)
  assert.equal(
    queue.begin({ callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2" }, 1).ok,
    false,
    "an omitted cursor is rejected once a page is exhausted",
  )
  assert.equal(
    queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2", cursor: "cursor-9" },
      1,
    ).ok,
    false,
    "a cursor that was never issued is rejected",
  )
  assert.equal(
    queue.begin(
      { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool_2", cursor: "cursor-2" },
      1,
    ).ok,
    true,
  )
})

test("queue capacity options are validated and capped at the hard cap", () => {
  assert.throws(() => createTranscriptQueue({ maxCallers: Number.NaN }), RangeError)
  assert.throws(() => createTranscriptQueue({ maxCallers: Number.POSITIVE_INFINITY }), RangeError)
  assert.throws(() => createTranscriptQueue({ maxCallers: Number.NEGATIVE_INFINITY }), RangeError)
  assert.throws(() => createTranscriptQueue({ maxCallers: 0 }), RangeError)
  assert.throws(() => createTranscriptQueue({ maxCallers: -1 }), RangeError)
  assert.throws(() => createTranscriptQueue({ maxCallers: 1.5 }), RangeError)

  const clamped = createTranscriptQueue({ maxCallers: 17 })
  for (let index = 0; index < QUEUE_MAX_CALLERS; index += 1) {
    assert.equal(
      clamped.begin({ callerSessionID: `ses_${index}`, targetSessionID: "ses_hist", requestMessageID: "msg" }, 0).ok,
      true,
    )
  }
  assert.equal(
    clamped.begin({ callerSessionID: "ses_over", targetSessionID: "ses_hist", requestMessageID: "msg" }, 0).ok,
    false,
    "17 is clamped to the hard cap",
  )

  const single = createTranscriptQueue({ maxCallers: 1 })
  assert.equal(single.begin({ callerSessionID: "ses_a", targetSessionID: "ses_hist", requestMessageID: "msg" }, 0).ok, true)
  assert.equal(single.begin({ callerSessionID: "ses_b", targetSessionID: "ses_hist", requestMessageID: "msg" }, 0).ok, false)
})

test("endReview and dispose release raw chunks and abort listeners", () => {
  const queue = createTranscriptQueue()
  const controller = new AbortController()
  const token = beginToken(
    queue,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_tool", signal: controller.signal },
    0,
  )
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" }, 0, token)
  assert.equal(getEventListeners(controller.signal, "abort").length, 1)
  queue.endReview("ses_call", "ses_hist")
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
  assert.equal(queue.has("ses_call"), false)
  assert.equal(queue.take("ses_call", 0), null)

  const other = createTranscriptQueue()
  const otherController = new AbortController()
  const otherToken = beginToken(
    other,
    { callerSessionID: "ses_other", targetSessionID: "ses_hist", requestMessageID: "msg_tool", signal: otherController.signal },
    0,
  )
  other.supply("ses_other", { entries: [{ messageID: "m2", text: "body" }], nextCursor: null }, 0, otherToken)
  assert.equal(getEventListeners(otherController.signal, "abort").length, 1)
  other.dispose()
  assert.equal(getEventListeners(otherController.signal, "abort").length, 0)
  assert.equal(other.size(), 0)
  assert.equal(other.take("ses_other", 0), null)
})

test("endReview rejects a mismatched target without discarding the binding", () => {
  const queue = createTranscriptQueue()
  const token = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg" }, 0)
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: "cursor-2" }, 0, token)

  const mismatch = queue.endReview("ses_call", "ses_other")
  assert.equal(mismatch.ok, false)
  if (!mismatch.ok) assert.match(mismatch.reason, /review target mismatch/)
  assert.equal(queue.has("ses_call"), true, "the mismatched end must not discard the active binding")
  assert.notEqual(queue.take("ses_call", 0), null, "the pending chunk survives a mismatched end")

  const matching = queue.endReview("ses_call", "ses_hist")
  assert.equal(matching.ok, true)
  assert.equal(queue.has("ses_call"), false)
})

test("endReview with no active binding succeeds and discardCaller clears any target", () => {
  const queue = createTranscriptQueue()
  assert.deepEqual(queue.endReview("ses_call", "ses_hist"), { ok: true })

  const token = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg" }, 0)
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: null }, 0, token)
  queue.discardCaller("ses_call")
  assert.equal(queue.has("ses_call"), false)
  assert.equal(queue.take("ses_call", 0), null)
})

test("endReview releases an expired binding for the matching target", () => {
  const queue = createTranscriptQueue({ ttlMs: 0 })
  const token = beginToken(queue, { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg" }, 0)
  queue.supply("ses_call", { entries: [{ messageID: "m1", text: "body" }], nextCursor: null }, 0, token)
  // The pending chunk is already ineligible, but the binding remains until an
  // explicit end; ending the matching review releases it.
  const ended = queue.endReview("ses_call", "ses_hist")
  assert.equal(ended.ok, true)
  assert.equal(queue.has("ses_call"), false)
  assert.equal(queue.take("ses_call", 61_000), null)
})

test("a zero-text supply consumes the fetch generation", () => {
  const queue = createTranscriptQueue()
  const controller = new AbortController()
  const token = beginToken(
    queue,
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg", signal: controller.signal },
    0,
  )
  assert.equal(getEventListeners(controller.signal, "abort").length, 1)

  const supplied = queue.supply("ses_call", { entries: [], nextCursor: "cursor-2" }, 0, token)
  assert.equal(supplied.ok, true)
  assert.equal(supplied.ok && supplied.ack.bytes, 0)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0, "no pending payload keeps no listener")

  const duplicate = queue.supply("ses_call", { entries: [], nextCursor: "cursor-2" }, 0, token)
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.match(duplicate.reason, /stale request/)
  assert.equal(queue.release("ses_call", token), false, "the consumed generation cannot be released again")

  const resumed = queue.begin(
    { callerSessionID: "ses_call", targetSessionID: "ses_hist", requestMessageID: "msg_2", cursor: "cursor-2" },
    1,
  )
  assert.equal(resumed.ok, true)
  if (resumed.ok) assert.equal(resumed.fetchCursor, "cursor-2")
})
