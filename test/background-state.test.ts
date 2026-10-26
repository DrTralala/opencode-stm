import { test } from "node:test"
import assert from "node:assert/strict"
import { hashTitle, initialMeta, type SessionMeta } from "../src/state.js"
import {
  REVIEW_REVOCATION_REASONS,
  isBackgroundAttempt,
  reserveReview,
  resolveBackgroundReview,
  revokeReview,
  type BackgroundAttempt,
} from "../src/background-state.js"

function freshAttempt(overrides: Partial<BackgroundAttempt> = {}): BackgroundAttempt {
  return {
    id: "attempt-1",
    reviewID: "review-1",
    ownerID: "owner-1",
    phase: "active",
    titleDigest: hashTitle("Old"),
    cutoffMessageID: "msg_dispatch",
    activityAtDispatch: 20,
    deadline: 120000,
    childSessionID: null,
    promptMessageID: null,
    stop: "not-started",
    failureCode: null,
    ...overrides,
  }
}

function activeAttempt(overrides: Partial<BackgroundAttempt> = {}): BackgroundAttempt {
  return freshAttempt({
    childSessionID: "ses_child",
    promptMessageID: "msg_prompt",
    stop: "pending",
    ...overrides,
  })
}

function metaWith(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    ...initialMeta(),
    activity: 20,
    titleDigest: hashTitle("Old"),
    review: { id: "review-1", remindersSent: 1, nextTriggerAt: 60 },
    ...overrides,
  }
}

test("background resolution keeps activity after dispatch", () => {
  const attempt = activeAttempt()
  const anchor = {
    reviewID: "review-1",
    reminderIndex: 0,
    anchorMessageID: "msg_anchor",
    partID: "stm-reminder-review-1-0",
    obsolete: false,
  }
  const meta = metaWith({
    activity: 27,
    frontier: ["msg_1", "msg_2"],
    anchors: [anchor],
    backgroundReview: attempt,
  })
  const resolved = resolveBackgroundReview(meta, attempt.id, hashTitle("New"))

  assert.equal(resolved.applied, true)
  assert.equal(resolved.next.activity, 7)
  assert.equal(resolved.next.review, null)
  assert.equal(resolved.next.backgroundReview, null)
  assert.equal(resolved.next.titleDigest, hashTitle("New"))
  assert.deepEqual(resolved.next.frontier, ["msg_1", "msg_2"])
  assert.deepEqual(resolved.next.anchors, [anchor])
  assert.equal(meta.activity, 27)
  assert.equal(meta.backgroundReview, attempt)
})

test("background resolution fails closed for stale or unbound attempts", () => {
  const attempt = activeAttempt()
  const cases: Array<{ name: string; meta: SessionMeta; attemptID: string }> = [
    { name: "wrong attempt", meta: metaWith({ backgroundReview: attempt }), attemptID: "attempt-other" },
    {
      name: "terminal attempt",
      meta: metaWith({
        backgroundReview: { ...attempt, phase: "failed", stop: "confirmed", failureCode: "background-internal-error" },
      }),
      attemptID: attempt.id,
    },
    { name: "missing review", meta: metaWith({ review: null, backgroundReview: attempt }), attemptID: attempt.id },
    {
      name: "wrong review",
      meta: metaWith({
        review: { id: "review-2", remindersSent: 1, nextTriggerAt: 60 },
        backgroundReview: attempt,
      }),
      attemptID: attempt.id,
    },
    {
      name: "changed title",
      meta: metaWith({ titleDigest: hashTitle("Changed"), backgroundReview: attempt }),
      attemptID: attempt.id,
    },
    {
      name: "locked metadata",
      meta: metaWith({ locked: true, lockReason: "manual", backgroundReview: attempt }),
      attemptID: attempt.id,
    },
    {
      name: "counter reset",
      meta: metaWith({ activity: 19, backgroundReview: attempt }),
      attemptID: attempt.id,
    },
  ]

  for (const entry of cases) {
    const resolved = resolveBackgroundReview(entry.meta, entry.attemptID, hashTitle("New"))
    assert.equal(resolved.applied, false, entry.name)
    assert.equal(resolved.next, entry.meta, entry.name)
  }
  assert.equal(cases.at(-1)?.meta.activity, 19)
})

test("reservation stores a fresh attempt without mutating the input", () => {
  const attempt = freshAttempt()
  const meta = metaWith()
  const reserved = reserveReview(meta, attempt, false)

  assert.equal(reserved.result.status, "queued")
  if (reserved.result.status !== "queued") return
  assert.deepEqual(reserved.result.attempt, attempt)
  assert.notEqual(reserved.next, meta)
  assert.deepEqual(reserved.next.backgroundReview, attempt)
  assert.equal(meta.backgroundReview, null)
  assert.deepEqual(reserved.next.review, meta.review)
  assert.equal(reserved.next.activity, meta.activity)
})

test("duplicate reservation reports the existing worker and never replaces it", () => {
  const first = reserveReview(metaWith(), freshAttempt(), false)
  assert.equal(first.result.status, "queued")

  const duplicate = reserveReview(first.next, freshAttempt({ id: "attempt-2" }), false)
  assert.deepEqual(duplicate.result, { status: "active" })
  assert.equal(duplicate.next, first.next)

  const retryDuplicate = reserveReview(first.next, freshAttempt(), true)
  assert.deepEqual(retryDuplicate.result, { status: "active" })
  assert.equal(retryDuplicate.next, first.next)
  assert.equal(retryDuplicate.next.backgroundReview?.id, "attempt-1")
})

test("reservation conflicts on locked, unbound or mismatched metadata", () => {
  const cases: Array<{ name: string; meta: SessionMeta; attempt: BackgroundAttempt }> = [
    {
      name: "locked",
      meta: metaWith({ locked: true, lockReason: "manual" }),
      attempt: freshAttempt(),
    },
    { name: "no review", meta: metaWith({ review: null }), attempt: freshAttempt() },
    {
      name: "wrong review",
      meta: metaWith({ review: { id: "review-2", remindersSent: 1, nextTriggerAt: 60 } }),
      attempt: freshAttempt(),
    },
    { name: "wrong digest", meta: metaWith({ titleDigest: hashTitle("Changed") }), attempt: freshAttempt() },
    {
      name: "terminal phase",
      meta: metaWith(),
      attempt: freshAttempt({ phase: "failed", failureCode: "background-internal-error" }),
    },
    { name: "remote work already attempted", meta: metaWith(), attempt: activeAttempt() },
  ]

  for (const entry of cases) {
    const reserved = reserveReview(entry.meta, entry.attempt, false)
    assert.deepEqual(reserved.result, { status: "conflict" }, entry.name)
    assert.equal(reserved.next, entry.meta, entry.name)
  }
})

test("explicit retry replaces only a safely stopped attempt for the same review", () => {
  const pendingActive = activeAttempt({ id: "attempt-old" })
  const blockedActive = reserveReview(
    metaWith({ backgroundReview: pendingActive }),
    freshAttempt({ id: "attempt-new" }),
    true,
  )
  assert.deepEqual(blockedActive.result, { status: "active" })
  assert.equal(blockedActive.next.backgroundReview, pendingActive)

  const pendingFailed = activeAttempt({
    id: "attempt-old",
    phase: "failed",
    failureCode: "background-internal-error",
  })
  const blockedFailed = reserveReview(
    metaWith({ backgroundReview: pendingFailed }),
    freshAttempt({ id: "attempt-new" }),
    true,
  )
  assert.deepEqual(blockedFailed.result, { status: "failed" })
  assert.equal(blockedFailed.next.backgroundReview, pendingFailed)

  const notStarted = freshAttempt({ id: "attempt-old" })
  const retriedNeverStarted = reserveReview(
    metaWith({ backgroundReview: notStarted }),
    freshAttempt({ id: "attempt-new" }),
    true,
  )
  assert.equal(retriedNeverStarted.result.status, "queued")
  assert.equal(retriedNeverStarted.next.backgroundReview?.id, "attempt-new")

  const confirmedFailed = activeAttempt({
    id: "attempt-old",
    phase: "failed",
    stop: "confirmed",
    failureCode: "background-internal-error",
  })
  const retriedConfirmed = reserveReview(
    metaWith({ backgroundReview: confirmedFailed }),
    freshAttempt({ id: "attempt-new" }),
    true,
  )
  assert.equal(retriedConfirmed.result.status, "queued")
  assert.equal(retriedConfirmed.next.backgroundReview?.id, "attempt-new")

  const noRetry = reserveReview(
    metaWith({ backgroundReview: confirmedFailed }),
    freshAttempt({ id: "attempt-new" }),
    false,
  )
  assert.deepEqual(noRetry.result, { status: "failed" })
  assert.equal(noRetry.next.backgroundReview, confirmedFailed)

  const uncertain = activeAttempt({
    id: "attempt-old",
    phase: "uncertain",
    stop: "confirmed",
    failureCode: "background-uncertain-write",
  })
  const refusedUncertain = reserveReview(
    metaWith({ backgroundReview: uncertain }),
    freshAttempt({ id: "attempt-new" }),
    true,
  )
  assert.deepEqual(refusedUncertain.result, { status: "uncertain" })
  assert.equal(refusedUncertain.next.backgroundReview, uncertain)
})

test("a new review cannot start while an old stop is pending", () => {
  const old = activeAttempt({
    id: "attempt-old",
    reviewID: "review-old",
    phase: "failed",
    failureCode: "background-internal-error",
  })
  const meta = metaWith({
    review: { id: "review-2", remindersSent: 1, nextTriggerAt: 60 },
    backgroundReview: old,
  })
  const reserved = reserveReview(meta, freshAttempt({ id: "attempt-new", reviewID: "review-2" }), true)

  assert.deepEqual(reserved.result, { status: "conflict" })
  assert.equal(reserved.next, meta)
})

test("a safely stopped old review is replaceable by a new review without retry", () => {
  const old = activeAttempt({
    id: "attempt-old",
    reviewID: "review-old",
    phase: "failed",
    stop: "confirmed",
    failureCode: "background-internal-error",
  })
  const meta = metaWith({
    review: { id: "review-2", remindersSent: 1, nextTriggerAt: 60 },
    backgroundReview: old,
  })
  const reserved = reserveReview(meta, freshAttempt({ id: "attempt-new", reviewID: "review-2" }), false)

  assert.equal(reserved.result.status, "queued")
  assert.equal(reserved.next.backgroundReview?.id, "attempt-new")
  assert.equal(reserved.next.backgroundReview?.reviewID, "review-2")
})

test("an uncertain terminal record blocks a new review until reconciliation", () => {
  const old = activeAttempt({
    id: "attempt-old",
    reviewID: "review-old",
    phase: "uncertain",
    stop: "confirmed",
    failureCode: "background-uncertain-write",
  })
  const meta = metaWith({
    review: { id: "review-2", remindersSent: 1, nextTriggerAt: 60 },
    backgroundReview: old,
  })
  const reserved = reserveReview(meta, freshAttempt({ id: "attempt-new", reviewID: "review-2" }), false)

  assert.deepEqual(reserved.result, { status: "uncertain" })
  assert.equal(reserved.next, meta)
})

test("revocation marks an active attempt failed and keeps its child pending", () => {
  const attempt = activeAttempt()
  const meta = metaWith({ backgroundReview: attempt })
  const revoked = revokeReview(meta, REVIEW_REVOCATION_REASONS.manualLock)

  assert.equal(revoked.review?.id, "review-1")
  assert.equal(revoked.backgroundReview?.phase, "failed")
  assert.equal(revoked.backgroundReview?.failureCode, "background-revoked")
  assert.equal(revoked.backgroundReview?.childSessionID, "ses_child")
  assert.equal(revoked.backgroundReview?.promptMessageID, "msg_prompt")
  assert.equal(revoked.backgroundReview?.stop, "pending")
  assert.equal(meta.backgroundReview?.phase, "active")
})

test("revocation never stores an external error string", () => {
  const meta = metaWith({ backgroundReview: activeAttempt() })
  const revoked = revokeReview(meta, "provider exploded: secret detail")

  assert.equal(revoked.backgroundReview?.failureCode, "background-revoked")
  assert.doesNotMatch(JSON.stringify(revoked.backgroundReview), /secret detail/)
})

test("revocation uses an allowlisted internal reason as the failure code", () => {
  const meta = metaWith({ backgroundReview: activeAttempt() })
  const revoked = revokeReview(meta, "background-timeout")

  assert.equal(revoked.backgroundReview?.failureCode, "background-timeout")
})

test("revocation clears an uncertain record only after a safe stop and reconciliation", () => {
  const pending = activeAttempt({
    id: "attempt-old",
    phase: "uncertain",
    failureCode: "background-uncertain-write",
  })
  const stillPending = revokeReview(
    metaWith({ backgroundReview: pending }),
    REVIEW_REVOCATION_REASONS.explicitResolution,
  )
  assert.equal(stillPending.backgroundReview, pending)

  const confirmed = activeAttempt({
    id: "attempt-old",
    phase: "uncertain",
    stop: "confirmed",
    failureCode: "background-uncertain-write",
  })
  const cleared = revokeReview(
    metaWith({ backgroundReview: confirmed }),
    REVIEW_REVOCATION_REASONS.explicitResolution,
  )
  assert.equal(cleared.backgroundReview, null)

  const manual = revokeReview(
    metaWith({ backgroundReview: confirmed }),
    REVIEW_REVOCATION_REASONS.manualLock,
  )
  assert.equal(manual.backgroundReview, confirmed)

  const failed = activeAttempt({
    id: "attempt-old",
    phase: "failed",
    stop: "confirmed",
    failureCode: "background-internal-error",
  })
  const retainedFailure = revokeReview(
    metaWith({ backgroundReview: failed }),
    REVIEW_REVOCATION_REASONS.explicitResolution,
  )
  assert.equal(retainedFailure.backgroundReview, failed)
})

test("background attempt validation accepts only exact internal shapes", () => {
  const valid = activeAttempt()
  assert.equal(isBackgroundAttempt(valid), true)
  assert.equal(isBackgroundAttempt(freshAttempt()), true)
  assert.equal(
    isBackgroundAttempt(
      activeAttempt({ childSessionID: null, promptMessageID: null, stop: "pending" }),
    ),
    true,
  )

  assert.equal(isBackgroundAttempt(null), false)
  assert.equal(isBackgroundAttempt({ ...valid, extra: true }), false)
  assert.equal(isBackgroundAttempt({ ...valid, phase: "queued" }), false)
  assert.equal(isBackgroundAttempt({ ...valid, stop: "stopped" }), false)
  assert.equal(isBackgroundAttempt({ ...valid, failureCode: "RAW_PROVIDER_ERROR" }), false)
  assert.equal(isBackgroundAttempt({ ...valid, activityAtDispatch: -1 }), false)
  assert.equal(isBackgroundAttempt({ ...valid, deadline: 1.5 }), false)
  assert.equal(isBackgroundAttempt({ ...valid, id: 1 }), false)
  assert.equal(isBackgroundAttempt({ ...valid, childSessionID: 1 }), false)
  assert.equal(
    isBackgroundAttempt({ ...valid, stop: "not-started", childSessionID: "ses_child" }),
    false,
  )
  assert.equal(
    isBackgroundAttempt({ ...valid, childSessionID: null, promptMessageID: "msg_prompt" }),
    false,
  )
})
