// Guarded application of an autonomous background review decision. The
// coordinator supplies a parsed decision and cannot mutate the parent title
// itself. Every authority check that protects the final transition is repeated
// inside the atomic state callback, including owner and attempt identity.

import { resolveBackgroundReview, type BackgroundAttempt } from "./background-state.js"
import { readSession, writeTitle, type SdkResult } from "./sdk.js"
import { hashTitle, type SessionMeta } from "./state.js"
import { validateTitle } from "./title.js"
import type { StmServices } from "./tools.js"

export type ReviewDecision = { decision: "keep" } | { decision: "rename"; title: string }

const UNCERTAIN_FAILURE_CODE = "background-uncertain-write"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

export function parseReviewDecision(value: unknown): SdkResult<ReviewDecision> {
  if (!isRecord(value)) return { ok: false, reason: "review: expected an object" }

  if (value.decision === "keep") {
    if (!hasOnlyKeys(value, ["decision"])) return { ok: false, reason: "review: unexpected keep fields" }
    return { ok: true, value: { decision: "keep" } }
  }

  if (value.decision === "rename") {
    if (!hasOnlyKeys(value, ["decision", "title"])) return { ok: false, reason: "review: unexpected rename fields" }
    if (typeof value.title !== "string") return { ok: false, reason: "review: title must be a string" }
    const valid = validateTitle(value.title)
    if (!valid.ok) return { ok: false, reason: `review: ${valid.reason}` }
    return { ok: true, value: { decision: "rename", title: valid.value } }
  }

  return { ok: false, reason: "review: unknown decision" }
}

export type BackgroundApplicationInput = {
  parentID: string
  attemptID: string
  ownerID: string
  decision: ReviewDecision
}

type ApplicationStatus = { status: "applied" | "discarded" | "uncertain" }

function boundAttempt(
  meta: SessionMeta,
  input: BackgroundApplicationInput,
  now: () => number,
  signal: AbortSignal,
): BackgroundAttempt | null {
  const attempt = meta.backgroundReview
  if (
    attempt === null ||
    attempt.id !== input.attemptID ||
    attempt.ownerID !== input.ownerID ||
    attempt.phase !== "active" ||
    signal.aborted ||
    now() >= attempt.deadline ||
    meta.locked ||
    meta.review === null ||
    meta.review.id !== attempt.reviewID ||
    meta.titleDigest !== attempt.titleDigest ||
    meta.activity < attempt.activityAtDispatch
  ) {
    return null
  }
  return attempt
}

async function persistUncertain(services: StmServices, input: BackgroundApplicationInput): Promise<void> {
  try {
    await services.state.updateIfPresent(input.parentID, (current) => {
      const attempt = current.backgroundReview
      if (attempt === null || attempt.id !== input.attemptID || attempt.ownerID !== input.ownerID) {
        return { next: current, result: false }
      }
      if (attempt.phase === "uncertain") return { next: current, result: true }
      return {
        next: {
          ...current,
          backgroundReview: { ...attempt, phase: "uncertain", failureCode: UNCERTAIN_FAILURE_CODE },
        },
        result: true,
      }
    })
  } catch {
    // The caller still reports uncertainty; a later explicit title operation
    // must inspect the live title. No fallback metadata is ever published.
  }
}

async function resolveKeep(
  services: StmServices,
  input: BackgroundApplicationInput,
  signal: AbortSignal,
  digest: string,
): Promise<ApplicationStatus> {
  const updated = await services.state.updateIfPresent<"applied" | "discarded">(input.parentID, (current) => {
    if (boundAttempt(current, input, services.now, signal) === null) {
      return { next: current, result: "discarded" }
    }
    const resolved = resolveBackgroundReview(current, input.attemptID, digest)
    if (!resolved.applied) return { next: current, result: "discarded" }
    return { next: resolved.next, result: "applied" }
  })
  if (!updated.ok) return { status: "discarded" }
  if (!updated.present) return { status: "discarded" }
  return { status: updated.value }
}

async function resolveRename(
  services: StmServices,
  input: BackgroundApplicationInput,
  signal: AbortSignal,
  title: string,
  digest: string,
): Promise<ApplicationStatus> {
  const written = await writeTitle(services.client, input.parentID, title, signal)
  if (!written.ok) {
    await persistUncertain(services, input)
    return { status: "uncertain" }
  }
  if (signal.aborted) {
    await persistUncertain(services, input)
    return { status: "uncertain" }
  }

  const after = await readSession(services.client, input.parentID, signal)
  if (signal.aborted || !after.ok || after.value.title !== title) {
    await persistUncertain(services, input)
    return { status: "uncertain" }
  }

  const updated = await services.state.updateIfPresent<"applied" | "discarded">(input.parentID, (current) => {
    if (boundAttempt(current, input, services.now, signal) === null) {
      return { next: current, result: "discarded" }
    }
    const resolved = resolveBackgroundReview(current, input.attemptID, digest)
    if (!resolved.applied) return { next: current, result: "discarded" }
    return { next: resolved.next, result: "applied" }
  })
  if (!updated.ok || !updated.present || updated.value !== "applied") {
    // The title may already have changed even though this attempt cannot be
    // attributed safely. Never write again; record uncertainty if authority is
    // still recognisable.
    await persistUncertain(services, input)
    return { status: "uncertain" }
  }
  return { status: "applied" }
}

async function applyGuarded(
  services: StmServices,
  input: BackgroundApplicationInput,
  signal: AbortSignal,
): Promise<ApplicationStatus> {
  if (signal.aborted) return { status: "discarded" }

  const loaded = await services.state.load(input.parentID)
  if (!loaded.ok || loaded.value === null) return { status: "discarded" }
  if (boundAttempt(loaded.value, input, services.now, signal) === null) return { status: "discarded" }

  const live = await readSession(services.client, input.parentID, signal)
  if (signal.aborted || !live.ok) return { status: "discarded" }
  const liveDigest = hashTitle(live.value.title)
  if (liveDigest !== loaded.value.titleDigest) return { status: "discarded" }

  // The title read is a suspension point. Re-read persisted authority before a
  // write so a lock, explicit resolution or revocation that landed during the
  // read wins without any SDK update.
  const confirmed = await services.state.load(input.parentID)
  if (!confirmed.ok || confirmed.value === null) return { status: "discarded" }
  const confirmedAttempt = boundAttempt(confirmed.value, input, services.now, signal)
  if (confirmedAttempt === null) return { status: "discarded" }

  if (input.decision.decision === "keep" || input.decision.title === live.value.title) {
    return resolveKeep(services, input, signal, liveDigest)
  }
  return resolveRename(services, input, signal, input.decision.title, hashTitle(input.decision.title))
}

export async function applyBackgroundDecision(
  services: StmServices,
  input: BackgroundApplicationInput,
  signal: AbortSignal,
): Promise<ApplicationStatus> {
  try {
    return await services.guard.run(input.parentID, () => applyGuarded(services, input, signal))
  } catch {
    return { status: "uncertain" }
  }
}
