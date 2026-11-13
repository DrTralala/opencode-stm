// test/review-input.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { createReviewSnapshots, formatReviewInput } from "../src/review-input.js"
import type { MutableMessage, MutablePart } from "../src/injection.js"

const SESSION = "ses_parent"
const BEGIN_MARKER = "----- BEGIN OPENCODE-STM REVIEW TRANSCRIPT (UNTRUSTED DATA) -----"
const END_MARKER = "----- END OPENCODE-STM REVIEW TRANSCRIPT (UNTRUSTED DATA) -----"

function textPart(id: string, text: string, extra: Record<string, unknown> = {}): MutablePart {
  return { id, type: "text", text, ...extra }
}

function message(
  id: string,
  role: string,
  parts: MutablePart[],
  extra: Record<string, unknown> = {},
  sessionID = SESSION,
): MutableMessage {
  return { info: { id, sessionID, role, ...extra }, parts }
}

function records(snapshot: { records: string }): Array<Record<string, unknown>> {
  return snapshot.records.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

test("capture retains ordinary text and synthetic summaries but excludes non-visible and STM-owned parts", () => {
  const messages = [
    message("msg_user", "user", [textPart("part_user", "USER_TEXT")]),
    message("msg_summary", "assistant", [
      textPart("part_summary", "RETAINED_SUMMARY", { synthetic: true }),
      textPart("part_ignored", "IGNORED_SECRET", { ignored: true }),
      textPart("part_reminder", "REMINDER_SECRET", {
        synthetic: true,
        metadata: { "opencode-stm": { reviewID: "review-1", reminderIndex: 0, contextID: "old-context" } },
      }),
      { id: "part_reasoning", type: "reasoning", text: "REASONING_SECRET" },
      { id: "part_file", type: "file", url: "https://example.invalid/ATTACHMENT_SECRET" },
      { id: "part_tool", type: "tool", tool: "bash", state: { input: "TOOL_CALL_SECRET", output: "TOOL_RESULT_SECRET" } },
    ], { summary: true }),
    message("msg_last_user", "user", [textPart("part_last_user", "LAST_USER_TEXT")], { summary: { title: "compaction" } }),
  ]
  const snapshots = createReviewSnapshots()
  const captured = snapshots.capture(SESSION, messages)

  assert.equal(captured.ok, true)
  if (!captured.ok) return
  assert.equal(captured.value.sessionID, SESSION)
  assert.equal(captured.value.parentUserID, "msg_last_user")
  assert.equal(captured.value.messageCount, 3)
  assert.equal(Object.isFrozen(captured.value), true)
  const lines = records(captured.value)
  assert.deepEqual(lines.map((record) => record.text), ["USER_TEXT", "RETAINED_SUMMARY", "LAST_USER_TEXT"])
  assert.deepEqual(lines.map((record) => record.role), ["user", "assistant", "user"])
  assert.doesNotMatch(captured.value.records, /IGNORED_SECRET|REMINDER_SECRET|REASONING_SECRET|ATTACHMENT_SECRET|TOOL_CALL_SECRET|TOOL_RESULT_SECRET/)
})

test("claim binds a snapshot to one assistant and rejects superseded and cross-session tokens", () => {
  const snapshots = createReviewSnapshots()
  const first = snapshots.capture(SESSION, [message("msg_user_a", "user", [textPart("p1", "FIRST")])])
  assert.equal(first.ok, true)
  if (!first.ok) return

  const second = snapshots.capture(SESSION, [message("msg_user_b", "user", [textPart("p2", "SECOND")])])
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.notEqual(first.value.contextID, second.value.contextID)
  assert.deepEqual(snapshots.claim(SESSION, first.value.contextID, "msg_dispatch"), {
    ok: false,
    reason: "review-context-stale",
  })
  assert.deepEqual(snapshots.claim("ses_other", second.value.contextID, "msg_dispatch"), {
    ok: false,
    reason: "review-context-session-mismatch",
  })

  const claimed = snapshots.claim(SESSION, second.value.contextID, "msg_dispatch")
  assert.deepEqual(claimed, { ok: true, value: second.value })
  assert.deepEqual(snapshots.claim(SESSION, second.value.contextID, "msg_dispatch"), claimed)
  assert.deepEqual(snapshots.claim(SESSION, second.value.contextID, "msg_other_dispatch"), {
    ok: false,
    reason: "review-context-stale",
  })
})

test("released, discarded and cleared snapshots retain no claimable conversation text", () => {
  const snapshots = createReviewSnapshots()
  const first = snapshots.capture(SESSION, [message("msg_user", "user", [textPart("p1", "PRIVATE")])])
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(snapshots.claim(SESSION, first.value.contextID, "msg_dispatch").ok, true)
  snapshots.release(SESSION, first.value.contextID)
  assert.deepEqual(snapshots.claim(SESSION, first.value.contextID, "msg_dispatch"), {
    ok: false,
    reason: "review-context-missing",
  })

  const second = snapshots.capture("ses_other", [message("msg_other_user", "user", [textPart("p2", "PRIVATE_2")], {}, "ses_other")])
  assert.equal(second.ok, true)
  if (!second.ok) return
  snapshots.discard("ses_other")
  assert.deepEqual(snapshots.claim("ses_other", second.value.contextID, "msg_dispatch"), {
    ok: false,
    reason: "review-context-missing",
  })

  const third = snapshots.capture(SESSION, [message("msg_user_3", "user", [textPart("p3", "PRIVATE_3")])])
  assert.equal(third.ok, true)
  if (!third.ok) return
  snapshots.clear()
  assert.deepEqual(snapshots.claim(SESSION, third.value.contextID, "msg_dispatch"), {
    ok: false,
    reason: "review-context-missing",
  })
})

test("capture rejects mixed sessions and malformed retained text attribution", () => {
  const snapshots = createReviewSnapshots()
  assert.deepEqual(
    snapshots.capture(SESSION, [
      message("msg_user", "user", [textPart("p1", "VISIBLE")]),
      { info: { id: "msg_foreign", sessionID: "ses_other", role: "user" }, parts: [textPart("p2", "FOREIGN")] },
    ]),
    { ok: false, reason: "review-snapshot-invalid" },
  )
  assert.deepEqual(
    snapshots.capture(SESSION, [message("msg_bad", "user", [{ type: "text", text: "NO_PART_ID" }])]),
    { ok: false, reason: "review-snapshot-invalid" },
  )
  assert.deepEqual(
    snapshots.capture(SESSION, [message("msg_bad", "user", [textPart("p1", "WRONG_MESSAGE", { messageID: "msg_other" })])]),
    { ok: false, reason: "review-snapshot-invalid" },
  )
  assert.deepEqual(
    snapshots.capture(SESSION, [message("msg_bad", "user", [textPart("p1", "WRONG_SESSION", { sessionID: "ses_other" })])]),
    { ok: false, reason: "review-snapshot-invalid" },
  )
})

test("formatReviewInput preserves retained content above the former byte cap without truncation", () => {
  const largeText = "😀漢字".repeat(40_000)
  const captured = createReviewSnapshots().capture(SESSION, [message("msg_user", "user", [textPart("p1", largeText)])])
  assert.equal(captured.ok, true)
  if (!captured.ok) return

  const prompt = formatReviewInput(captured.value, 'Existing "quoted" title')
  assert.ok(Buffer.byteLength(prompt, "utf8") > 131072)
  assert.ok(prompt.includes(largeText))
  assert.ok(prompt.includes(JSON.stringify('Existing "quoted" title')))
  assert.ok(prompt.startsWith("OpenCode STM background title review."))
  assert.match(prompt, /exactly one JSON object/i)
  assert.match(prompt, /untrusted/i)
  assert.equal(prompt.split("\n").filter((line) => line === BEGIN_MARKER).length, 1)
  assert.equal(prompt.split("\n").filter((line) => line === END_MARKER).length, 1)
})
