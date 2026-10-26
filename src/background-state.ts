import type { SessionMeta } from "./state.js"

// Failure codes are deliberately a closed internal vocabulary. External error
// messages must never reach persisted metadata or user-facing diagnostics.
export const BACKGROUND_FAILURE_CODES = [
  "background-timeout",
  "background-cancelled",
  "background-revoked",
  "background-internal-error",
  "background-input-rejected",
  "background-create-failed",
  "background-prompt-failed",
  "background-child-error",
  "background-result-discarded",
  "background-uncertain-write",
] as const

type BackgroundFailureCode = (typeof BACKGROUND_FAILURE_CODES)[number]

// Revocation callers share these labels so a terminal uncertain record is only
// cleared by a transition that has reconciled the live title. A manual lock
// without a live-title check must not erase uncertainty.
export const REVIEW_REVOCATION_REASONS = {
  manualLock: "manual-lock",
  externalTitleChange: "external-title-change",
  unlock: "unlock",
  explicitResolution: "explicit-resolution",
  titleReconciled: "title-reconciled",
} as const

const RECONCILING_REVOCATION_REASONS: ReadonlySet<string> = new Set([
  REVIEW_REVOCATION_REASONS.externalTitleChange,
  REVIEW_REVOCATION_REASONS.unlock,
  REVIEW_REVOCATION_REASONS.explicitResolution,
  REVIEW_REVOCATION_REASONS.titleReconciled,
])

const REVOCATION_FAILURE_CODE: BackgroundFailureCode = "background-revoked"

export type BackgroundAttempt = {
  id: string
  reviewID: string
  ownerID: string
  phase: "active" | "failed" | "uncertain"
  titleDigest: string
  cutoffMessageID: string
  activityAtDispatch: number
  deadline: number
  childSessionID: string | null
  promptMessageID: string | null
  stop: "not-started" | "pending" | "confirmed"
  failureCode: string | null
}

export type Reservation =
  | { status: "queued"; attempt: BackgroundAttempt }
  | { status: "active" | "failed" | "uncertain" | "conflict" }

const ATTEMPT_KEYS = [
  "id",
  "reviewID",
  "ownerID",
  "phase",
  "titleDigest",
  "cutoffMessageID",
  "activityAtDispatch",
  "deadline",
  "childSessionID",
  "promptMessageID",
  "stop",
  "failureCode",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isBackgroundFailureCode(value: unknown): value is BackgroundFailureCode {
  return typeof value === "string" && (BACKGROUND_FAILURE_CODES as readonly string[]).includes(value)
}

export function isBackgroundAttempt(value: unknown): value is BackgroundAttempt {
  if (!isRecord(value)) return false
  if (!hasOnlyKeys(value, ATTEMPT_KEYS)) return false
  if (!isNonEmptyString(value.id)) return false
  if (!isNonEmptyString(value.reviewID)) return false
  if (!isNonEmptyString(value.ownerID)) return false
  if (value.phase !== "active" && value.phase !== "failed" && value.phase !== "uncertain") return false
  if (!isNonEmptyString(value.titleDigest)) return false
  if (!isNonEmptyString(value.cutoffMessageID)) return false
  if (!Number.isInteger(value.activityAtDispatch) || (value.activityAtDispatch as number) < 0) return false
  if (!Number.isInteger(value.deadline) || (value.deadline as number) < 0) return false
  if (!(value.childSessionID === null || isNonEmptyString(value.childSessionID))) return false
  if (!(value.promptMessageID === null || isNonEmptyString(value.promptMessageID))) return false
  if (value.stop !== "not-started" && value.stop !== "pending" && value.stop !== "confirmed") return false
  if (!(value.failureCode === null || isBackgroundFailureCode(value.failureCode))) return false
  if (value.stop === "not-started" && (value.childSessionID !== null || value.promptMessageID !== null)) {
    return false
  }
  if (value.promptMessageID !== null && value.childSessionID === null) return false
  return true
}

function conflict(meta: SessionMeta): { next: SessionMeta; result: Reservation } {
  return { next: meta, result: { status: "conflict" } }
}

export function reserveReview(
  meta: SessionMeta,
  attempt: BackgroundAttempt,
  retry: boolean,
): { next: SessionMeta; result: Reservation } {
  if (!isBackgroundAttempt(attempt)) return conflict(meta)
  if (meta.locked) return conflict(meta)
  if (meta.review === null || meta.review.id !== attempt.reviewID) return conflict(meta)
  if (meta.titleDigest !== attempt.titleDigest) return conflict(meta)

  const existing = meta.backgroundReview
  if (existing !== null && existing.id === attempt.id) {
    return { next: meta, result: { status: existing.phase } }
  }

  if (existing !== null) {
    // An uncertain title write requires explicit reconciliation, never a retry.
    if (existing.phase === "uncertain") {
      return { next: meta, result: { status: "uncertain" } }
    }
    if (existing.reviewID !== attempt.reviewID) {
      // The stored attempt belongs to a review that is no longer current. It
      // may be replaced only after its worker has stopped (or never started).
      if (existing.stop === "pending") return conflict(meta)
    } else {
      if (!retry) return { next: meta, result: { status: existing.phase } }
      // A pending stop blocks replacement even with an explicit retry.
      if (existing.stop === "pending") return { next: meta, result: { status: existing.phase } }
    }
  }

  // A reservation is stored before any remote work: it may not already claim a
  // child or prompt, and it must still be in its initial stop state.
  if (attempt.phase !== "active" || attempt.stop !== "not-started") return conflict(meta)

  const queued: BackgroundAttempt = { ...attempt }
  return { next: { ...meta, backgroundReview: queued }, result: { status: "queued", attempt: queued } }
}

export function revokeReview(meta: SessionMeta, reason: string): SessionMeta {
  const attempt = meta.backgroundReview
  if (attempt === null) return meta

  if (attempt.phase === "uncertain") {
    if (attempt.stop === "pending") return meta
    if (!RECONCILING_REVOCATION_REASONS.has(reason)) return meta
    return { ...meta, backgroundReview: null }
  }

  // Failed records are terminal: an explicit retry, not a revocation, decides
  // whether another worker may be started.
  if (attempt.phase === "failed") return meta

  const failureCode = isBackgroundFailureCode(reason) ? reason : REVOCATION_FAILURE_CODE
  return {
    ...meta,
    backgroundReview: { ...attempt, phase: "failed", failureCode },
  }
}

export function resolveBackgroundReview(
  meta: SessionMeta,
  attemptID: string,
  digest: string,
): { next: SessionMeta; applied: boolean } {
  const attempt = meta.backgroundReview
  if (
    attempt === null ||
    attempt.id !== attemptID ||
    attempt.phase !== "active" ||
    meta.locked ||
    meta.review === null ||
    meta.review.id !== attempt.reviewID ||
    meta.titleDigest !== attempt.titleDigest ||
    meta.activity < attempt.activityAtDispatch
  ) {
    return { next: meta, applied: false }
  }

  return {
    next: {
      ...meta,
      activity: meta.activity - attempt.activityAtDispatch,
      review: null,
      backgroundReview: null,
      titleDigest: digest,
    },
    applied: true,
  }
}
