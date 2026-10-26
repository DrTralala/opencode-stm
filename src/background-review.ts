// Admission and asynchronous coordination for the background title reviewer.
// The coordinator owns reservations, detached child work, deadlines, bounded
// completion reconciliation and revocation. It never applies a title itself:
// the injected ReviewApplier owns guarded decision validation and application.

import { randomBytes, randomUUID } from "node:crypto"
import type { ToolContext } from "@opencode-ai/plugin"
import type { ReviewerConfig } from "./config.js"
import { reserveReview, revokeReview, type BackgroundAttempt, type Reservation } from "./background-state.js"
import { collectReviewInput } from "./review-input.js"
import {
  createReviewChild,
  promptReviewChild,
  readReviewCompletion,
  readReviewExecutionContext,
  readSession,
  stopReviewChild,
  type Client,
  type PermissionRule,
  type ReviewAgent,
} from "./sdk.js"
import { hashTitle, type SessionMeta } from "./state.js"
import type { StmServices } from "./tools.js"

export type ReviewStartArgs = { reviewID: string; expectedTitle: string; retry?: boolean }
export type ReviewStartResult = {
  status:
    | "queued"
    | "active"
    | "failed"
    | "uncertain"
    | "disabled"
    | "denied"
    | "aborted"
    | "conflict"
    | "error"
  reason?: string
}
export type BackgroundReviewer = {
  start(args: ReviewStartArgs, context: ToolContext): Promise<ReviewStartResult>
  onEvent(event: unknown): Promise<void>
  reconcile(parentID: string): Promise<void>
  cancel(parentID: string, reason: string): Promise<void>
  dispose(): Promise<void>
}
export type ReviewApplier = (
  input: { parentID: string; attemptID: string; ownerID: string; structured: unknown },
  signal: AbortSignal,
) => Promise<{ status: "applied" | "discarded" | "uncertain" }>

const POLL_INTERVAL_MS = 1000
const STOP_TIMEOUT_MS = 5000
const NOTICE_TITLE = "STM title review"
const STOP_UNCONFIRMED_NOTICE = "[opencode-stm] background title review stop could not be confirmed"

type OwnedJob = {
  parentID: string
  attempt: BackgroundAttempt
  agent: ReviewAgent
  permissions: PermissionRule[]
  reviewer: ReviewerConfig
  title: string
  controller: AbortController
  settled: boolean
  applying: boolean
  createAttempted: boolean
  childID: string | null
  promptMessageID: string | null
  promptText: string | null
  pollTimer: NodeJS.Timeout | null
  deadlineTimer: NodeJS.Timeout | null
  reconcileQueued: boolean
  reconcileWait: Promise<void>
  reconcileChain: Promise<void>
}

type ToastFunction = (input: {
  body: { title?: string; message: string; variant: "error"; duration?: number }
  signal?: AbortSignal
}) => Promise<{ error?: unknown } | undefined | null>

type AskOutcome = { ok: true } | { ok: false; status: "denied" | "aborted" }

type Termination = {
  revoked: boolean
  record: BackgroundAttempt | null
}

type ReservationStep = { aborted: true } | { aborted: false; reservation: Reservation }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function validStartArgs(args: ReviewStartArgs): boolean {
  return (
    isRecord(args) &&
    isNonEmptyString(args.reviewID) &&
    typeof args.expectedTitle === "string" &&
    (args.retry === undefined || typeof args.retry === "boolean")
  )
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function base32(value: bigint, length: number): string {
  let encoded = ""
  let remaining = value
  for (let index = 0; index < length; index += 1) {
    encoded = CROCKFORD[Number(remaining & 31n)]! + encoded
    remaining >>= 5n
  }
  return encoded
}

// Explicit prompt message IDs are accepted by the host as `msg_` plus a
// 26-character ULID. Generate rather than reuse an arbitrary SDK value.
function newPromptMessageID(time: number): string {
  // `&` would truncate to 32 bits, so mask as BigInt to preserve the ULID's
  // 48-bit timestamp while still fixing the generated ID length.
  const milliseconds = BigInt(Math.max(0, Math.floor(time))) & 0xffffffffffffn
  const randomness = BigInt(`0x${randomBytes(10).toString("hex")}`)
  return `msg_${base32(milliseconds, 10)}${base32(randomness, 16)}`
}

function failureNotice(code: string): string {
  if (code === "background-timeout") {
    return "Background title review timed out. Check the session title before dispatching again."
  }
  if (code === "background-result-discarded") {
    return "Background title review was discarded. The title was not changed."
  }
  return "Background title review failed. Check the session title before dispatching again."
}

function toastApi(client: Client): ToastFunction | null {
  const tui = (client as unknown as { tui?: { showToast?: unknown } }).tui
  if (tui === undefined || typeof tui.showToast !== "function") return null
  return tui.showToast.bind(tui) as ToastFunction
}

async function boundedStop(client: Client, childID: string): Promise<boolean> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | null = null
  const fallback = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(false)
    }, STOP_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    const stop = stopReviewChild(client, childID, controller.signal).then(
      (result) => result.ok && result.value.confirmed,
      () => false,
    )
    return await Promise.race([stop, fallback])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

async function askFor(
  context: ToolContext,
  permission: string,
  patterns: string[],
  metadata: Record<string, unknown>,
): Promise<AskOutcome> {
  if (context.abort.aborted) return { ok: false, status: "aborted" }
  try {
    await context.ask({ permission, patterns, always: [], metadata })
  } catch {
    return { ok: false, status: context.abort.aborted ? "aborted" : "denied" }
  }
  if (context.abort.aborted) return { ok: false, status: "aborted" }
  return { ok: true }
}

function eventSessionID(event: unknown): string | null {
  if (!isRecord(event) || typeof event.type !== "string" || !isRecord(event.properties)) return null
  const sessionID = event.properties.sessionID
  if (!isNonEmptyString(sessionID)) return null
  if (event.type === "session.idle" || event.type === "session.error") return sessionID
  if (event.type === "session.status") {
    const status = event.properties.status
    return isRecord(status) && status.type === "idle" ? sessionID : null
  }
  return null
}

function deletedSessionID(event: unknown): string | null {
  if (!isRecord(event) || event.type !== "session.deleted" || !isRecord(event.properties)) return null
  const info = event.properties.info
  return isRecord(info) && isNonEmptyString(info.id) ? info.id : null
}

export function createBackgroundReviewer(services: StmServices, apply: ReviewApplier): BackgroundReviewer {
  const ownerID = randomUUID()
  const jobs = new Map<string, OwnedJob>()
  let disposed = false

  function now(): number {
    return services.now()
  }

  function removeJob(job: OwnedJob): void {
    if (jobs.get(job.parentID) === job) jobs.delete(job.parentID)
  }

  function clearTimers(job: OwnedJob): void {
    if (job.pollTimer !== null) {
      clearTimeout(job.pollTimer)
      job.pollTimer = null
    }
    if (job.deadlineTimer !== null) {
      clearTimeout(job.deadlineTimer)
      job.deadlineTimer = null
    }
  }

  function settleJob(job: OwnedJob): boolean {
    if (job.settled) return false
    job.settled = true
    clearTimers(job)
    job.promptText = null
    job.controller.abort()
    removeJob(job)
    return true
  }

  async function emitNotice(message: string): Promise<void> {
    try {
      const show = toastApi(services.client)
      if (show !== null) {
        const result = await show({
          body: { title: NOTICE_TITLE, message, variant: "error", duration: 5000 },
        })
        if (result === undefined || result === null || result.error === undefined || result.error === null) {
          return
        }
      }
    } catch {
      // Fall through to the fixed diagnostic below.
    }
    try {
      console.error(`[opencode-stm] ${message}`)
    } catch {
      // A failing stderr sink must not reject a background failure handler.
    }
  }

  function reportStopUnconfirmed(): void {
    try {
      console.error(STOP_UNCONFIRMED_NOTICE)
    } catch {
      // Diagnostics are best effort.
    }
  }

  async function revokeState(
    parentID: string,
    attemptID: string,
    targetOwnerID: string,
    code: string,
    unknownCreate: boolean,
  ): Promise<{ ok: boolean; value: Termination | null }> {
    const updated = await services.state.updateIfPresent<Termination>(parentID, (current) => {
      const attempt = current.backgroundReview
      if (attempt === null || attempt.id !== attemptID || attempt.ownerID !== targetOwnerID) {
        return { next: current, result: { revoked: false, record: attempt } }
      }
      if (attempt.phase === "active") {
        let next = revokeReview(current, code)
        let record = next.backgroundReview
        if (record !== null && unknownCreate && record.stop === "not-started") {
          record = { ...record, stop: "pending" }
          next = { ...next, backgroundReview: record }
        }
        return { next, result: { revoked: true, record } }
      }
      // A concurrent revocation may have terminated the attempt while a create
      // was in flight. Preserve the ambiguity so a replacement stays blocked.
      if (attempt.phase === "failed" && unknownCreate && attempt.stop === "not-started") {
        const record = { ...attempt, stop: "pending" as const }
        return { next: { ...current, backgroundReview: record }, result: { revoked: false, record } }
      }
      return { next: current, result: { revoked: false, record: attempt } }
    })
    if (!updated.ok) return { ok: false, value: null }
    return { ok: true, value: updated.present ? updated.value : null }
  }

  async function recordStop(
    parentID: string,
    attemptID: string,
    targetOwnerID: string,
    confirmed: boolean,
    expectedChildID?: string | null,
  ): Promise<void> {
    await services.state.updateIfPresent(parentID, (current) => {
      const attempt = current.backgroundReview
      if (attempt === null || attempt.id !== attemptID || attempt.ownerID !== targetOwnerID) {
        return { next: current, result: false }
      }
      if (expectedChildID !== undefined && attempt.childSessionID !== expectedChildID) {
        return { next: current, result: false }
      }
      if (attempt.phase === "uncertain") {
        // Uncertainty may be recorded while the child is already finishing. A
        // confirmed stop remains safe to attribute so explicit title
        // reconciliation can later clear the terminal record.
        if (!confirmed || attempt.stop === "confirmed") return { next: current, result: false }
        return {
          next: { ...current, backgroundReview: { ...attempt, stop: "confirmed" } },
          result: true,
        }
      }
      if (!confirmed && attempt.stop === "confirmed") return { next: current, result: false }
      return {
        next: { ...current, backgroundReview: { ...attempt, stop: confirmed ? "confirmed" : "pending" } },
        result: true,
      }
    })
  }

  async function terminate(
    job: OwnedJob,
    code: string,
    notify: boolean,
    extraChildID: string | null,
  ): Promise<void> {
    if (!settleJob(job)) return
    try {
      const changed = await revokeState(
        job.parentID,
        job.attempt.id,
        ownerID,
        code,
        job.createAttempted && (job.childID ?? extraChildID) === null,
      )
      const record = changed.value?.record ?? null
      const childID = extraChildID ?? job.childID ?? record?.childSessionID ?? null
      if (childID !== null && record?.stop !== "confirmed") {
        const confirmed = await boundedStop(services.client, childID)
        await recordStop(job.parentID, job.attempt.id, ownerID, confirmed)
        if (!confirmed) reportStopUnconfirmed()
      }
    } catch {
      // The notification below remains fixed even if cleanup was incomplete.
    }
    if (notify) await emitNotice(failureNotice(code))
  }

  async function failOwnedReview(job: OwnedJob, code: string): Promise<void> {
    try {
      await terminate(job, code, true, null)
    } catch {
      // failOwnedReview must never reject and create an unhandled rejection.
    }
  }

  async function finishUncertain(job: OwnedJob): Promise<void> {
    if (!settleJob(job)) return
    try {
      const loaded = await services.state.load(job.parentID)
      const stored = loaded.ok ? loaded.value?.backgroundReview ?? null : null
      const childID = job.childID ?? stored?.childSessionID ?? null
      if (
        childID !== null &&
        stored !== null &&
        stored.ownerID === ownerID &&
        stored.stop !== "confirmed"
      ) {
        const confirmed = await boundedStop(services.client, childID)
        await recordStop(job.parentID, job.attempt.id, ownerID, confirmed)
        if (!confirmed) reportStopUnconfirmed()
      }
    } catch {
      // Recording uncertainty is still valid even when the stop result cannot
      // be attributed; preserve the pending stop and continue the notice.
    }
    await emitNotice("Background title review needs reconciliation. Check the session title.")
  }

  async function childDeleted(job: OwnedJob): Promise<void> {
    if (!settleJob(job)) return
    try {
      await revokeState(job.parentID, job.attempt.id, ownerID, "background-child-error", false)
      // The child object no longer exists, so a remote stop is unnecessary and
      // the retained record is safe to replace through explicit reconciliation.
      await recordStop(job.parentID, job.attempt.id, ownerID, true)
    } catch {
      // The deleted child cannot apply a late result, and state is never
      // recreated through a fallback metadata object.
    }
  }

  function schedulePoll(job: OwnedJob): void {
    if (disposed || job.settled || job.pollTimer !== null) return
    const timer = setTimeout(() => {
      job.pollTimer = null
      void requestReconcile(job).finally(() => schedulePoll(job))
    }, POLL_INTERVAL_MS)
    timer.unref?.()
    job.pollTimer = timer
  }

  function requestReconcile(job: OwnedJob): Promise<void> {
    if (disposed || job.settled) return Promise.resolve()
    if (job.reconcileQueued) return job.reconcileWait
    job.reconcileQueued = true
    const run = job.reconcileChain
      .then(
        async () => {
          job.reconcileQueued = false
          await reconcileJob(job)
        },
        async () => {
          job.reconcileQueued = false
          await reconcileJob(job)
        },
      )
      .catch(async () => {
        await failOwnedReview(job, "background-internal-error")
      })
    job.reconcileChain = run.then(
      () => undefined,
      () => undefined,
    )
    job.reconcileWait = run
    return run
  }

  async function reconcileJob(job: OwnedJob): Promise<void> {
    if (disposed || job.settled || job.applying) return
    if (job.childID === null || job.promptMessageID === null) return
    if (now() >= job.attempt.deadline) {
      await failOwnedReview(job, "background-timeout")
      return
    }
    if (job.controller.signal.aborted) return

    const loaded = await services.state.load(job.parentID)
    if (job.settled) return
    if (!loaded.ok) return
    const meta = loaded.value
    const attempt = meta?.backgroundReview ?? null
    if (
      meta === null ||
      attempt === null ||
      attempt.id !== job.attempt.id ||
      attempt.ownerID !== ownerID ||
      attempt.phase !== "active"
    ) {
      // Authority is gone: release resources without applying or revising state.
      settleJob(job)
      return
    }
    if (now() >= job.attempt.deadline) {
      await failOwnedReview(job, "background-timeout")
      return
    }

    const completion = await readReviewCompletion(
      services.client,
      job.childID,
      job.promptMessageID,
      job.controller.signal,
    )
    if (job.settled) return
    if (now() >= job.attempt.deadline) {
      await failOwnedReview(job, "background-timeout")
      return
    }
    if (!completion.ok) return
    if (completion.value.status === "pending") return
    if (completion.value.status === "error") {
      await failOwnedReview(job, "background-child-error")
      return
    }
    if (job.applying) return

    job.applying = true
    let result: Awaited<ReturnType<ReviewApplier>>
    try {
      result = await apply(
        {
          parentID: job.parentID,
          attemptID: job.attempt.id,
          ownerID,
          structured: completion.value.structured,
        },
        job.controller.signal,
      )
    } catch {
      job.applying = false
      await failOwnedReview(job, "background-internal-error")
      return
    }
    job.applying = false
    if (job.settled) return

    if (result.status === "applied") {
      settleJob(job)
      return
    }
    if (result.status === "discarded") {
      await failOwnedReview(job, "background-result-discarded")
      return
    }
    if (result.status === "uncertain") {
      await finishUncertain(job)
      return
    }
    await failOwnedReview(job, "background-internal-error")
  }

  async function revalidateBeforeCreate(job: OwnedJob): Promise<boolean> {
    if (job.settled) return false
    if (job.controller.signal.aborted) {
      if (!job.settled && now() >= job.attempt.deadline) {
        await failOwnedReview(job, "background-timeout")
      }
      return false
    }
    if (now() >= job.attempt.deadline) {
      await failOwnedReview(job, "background-timeout")
      return false
    }
    const live = await readSession(services.client, job.parentID, job.controller.signal)
    if (job.settled) return false
    if (!live.ok) {
      await failOwnedReview(job, "background-internal-error")
      return false
    }
    if (live.value.title !== job.title) {
      await failOwnedReview(job, "background-revoked")
      return false
    }
    const loaded = await services.state.load(job.parentID)
    if (job.settled) return false
    if (!loaded.ok || loaded.value === null) {
      await failOwnedReview(job, "background-internal-error")
      return false
    }
    const meta = loaded.value
    const attempt = meta.backgroundReview
    if (
      attempt === null ||
      attempt.id !== job.attempt.id ||
      attempt.ownerID !== ownerID ||
      attempt.phase !== "active" ||
      meta.locked ||
      meta.review?.id !== job.attempt.reviewID ||
      meta.titleDigest !== job.attempt.titleDigest
    ) {
      await failOwnedReview(job, "background-revoked")
      return false
    }
    if (now() >= job.attempt.deadline) {
      await failOwnedReview(job, "background-timeout")
      return false
    }
    return true
  }

  async function revalidateBeforePrompt(job: OwnedJob, childID: string): Promise<boolean> {
    if (job.settled) return false
    if (job.controller.signal.aborted) {
      if (!job.settled && now() >= job.attempt.deadline) {
        await failOwnedReview(job, "background-timeout")
      }
      return false
    }
    if (now() >= job.attempt.deadline) {
      await failOwnedReview(job, "background-timeout")
      return false
    }
    const latest = await services.state.load(job.parentID)
    if (job.settled) return false
    if (!latest.ok) {
      await terminate(job, "background-internal-error", true, childID)
      return false
    }
    const meta = latest.value
    const attempt = meta?.backgroundReview ?? null
    if (
      meta === null ||
      attempt === null ||
      attempt.id !== job.attempt.id ||
      attempt.ownerID !== ownerID ||
      attempt.phase !== "active" ||
      attempt.childSessionID !== childID ||
      attempt.promptMessageID !== job.promptMessageID ||
      meta.locked ||
      meta.review === null ||
      meta.review.id !== job.attempt.reviewID ||
      meta.titleDigest !== job.attempt.titleDigest
    ) {
      // Revoked, resolved, locked or deleted after child-ID persistence: do not
      // disclose the transcript or make a provider prompt call.
      await terminate(job, "background-revoked", false, childID)
      return false
    }
    return true
  }

  async function runAcceptedReview(job: OwnedJob): Promise<void> {
    try {
      if (disposed || job.settled) return
      if (now() >= job.attempt.deadline) {
        await failOwnedReview(job, "background-timeout")
        return
      }

      const collected = await collectReviewInput(
        services.client,
        {
          sessionID: job.parentID,
          cutoffMessageID: job.attempt.cutoffMessageID,
          title: job.title,
          config: job.reviewer.transcript,
        },
        job.controller.signal,
      )
      if (job.settled) return
      if (!collected.ok) {
        if (job.controller.signal.aborted) {
          if (!job.settled && now() >= job.attempt.deadline) {
            await failOwnedReview(job, "background-timeout")
          }
          return
        }
        await failOwnedReview(job, "background-input-rejected")
        return
      }
      job.promptText = collected.value.text

      if (!(await revalidateBeforeCreate(job))) return

      job.createAttempted = true
      const created = await createReviewChild(
        services.client,
        {
          parentID: job.parentID,
          agent: job.agent,
          permissions: job.permissions,
          attemptID: job.attempt.id,
        },
        job.controller.signal,
      )
      if (job.settled) {
        if (created.ok) {
          try {
            const confirmed = await boundedStop(services.client, created.value.id)
            // Cancellation/disposal did not know this child ID. Attribute the
            // late stop to the same attempt and owner so a confirmed stop can
            // unblock an explicit retry, while an unconfirmed stop stays
            // pending and replacement remains blocked.
            await recordStop(job.parentID, job.attempt.id, ownerID, confirmed)
            if (!confirmed) reportStopUnconfirmed()
          } catch {
            // The absent-safe stop record leaves a pending stop unchanged. The
            // child has no authority to mutate the parent and may be inspected.
          }
        }
        return
      }
      if (!created.ok) {
        // A create request may have succeeded without yielding an ID. Retain an
        // unconfirmed stop so no automatic second child can be created.
        await failOwnedReview(job, "background-create-failed")
        return
      }

      const childID = created.value.id
      const promptMessageID = newPromptMessageID(now())
      job.childID = childID
      job.promptMessageID = promptMessageID
      const persisted = await services.state.updateIfPresent<boolean>(job.parentID, (current) => {
        const attempt = current.backgroundReview
        if (
          attempt === null ||
          attempt.id !== job.attempt.id ||
          attempt.ownerID !== ownerID ||
          attempt.phase !== "active" ||
          attempt.childSessionID !== null ||
          attempt.promptMessageID !== null
        ) {
          return { next: current, result: false }
        }
        return {
          next: {
            ...current,
            backgroundReview: { ...attempt, childSessionID: childID, promptMessageID, stop: "pending" },
          },
          result: true,
        }
      })
      if (job.settled) {
        void boundedStop(services.client, childID).catch(() => {})
        return
      }
      if (!persisted.ok) {
        await failOwnedReview(job, "background-internal-error")
        return
      }
      if (!persisted.present || persisted.value !== true) {
        // State was deleted or authority changed between creation and the
        // child-ID write. Stop the child without publishing fallback metadata.
        await terminate(job, "background-revoked", false, childID)
        return
      }
      if (now() >= job.attempt.deadline) {
        await failOwnedReview(job, "background-timeout")
        return
      }
      if (!(await revalidateBeforePrompt(job, childID))) return

      const prompted = await promptReviewChild(
        services.client,
        {
          childID,
          promptMessageID,
          agent: job.agent,
          text: collected.value.text,
        },
        job.controller.signal,
      )
      job.promptText = null
      if (job.settled) return
      if (!prompted.ok) {
        await failOwnedReview(job, "background-prompt-failed")
        return
      }
      if (now() >= job.attempt.deadline) {
        await failOwnedReview(job, "background-timeout")
        return
      }

      schedulePoll(job)
      void requestReconcile(job)
    } finally {
      job.promptText = null
    }
  }

  function earlyStatus(meta: SessionMeta, args: ReviewStartArgs): ReviewStartResult | null {
    if (meta.locked) return { status: "conflict", reason: "locked" }
    if (meta.review === null || meta.review.id !== args.reviewID) {
      return { status: "conflict", reason: "stale-review" }
    }
    const existing = meta.backgroundReview
    if (existing === null) return null
    if (existing.phase === "uncertain") return { status: "uncertain" }
    if (existing.ownerID !== ownerID && existing.phase === "active" && now() < existing.deadline) {
      return { status: "active", reason: "foreign-owner" }
    }
    if (existing.reviewID !== args.reviewID) {
      if (existing.stop === "pending") return { status: "conflict", reason: "stale-review" }
      return null
    }
    if (existing.phase === "active") return { status: "active" }
    if (existing.phase === "failed") {
      if (args.retry !== true || existing.stop === "pending") return { status: "failed" }
    }
    return null
  }

  async function revokeAndStop(
    parentID: string,
    attempt: BackgroundAttempt,
    code: string,
    unknownCreate: boolean,
  ): Promise<void> {
    const changed = await revokeState(parentID, attempt.id, attempt.ownerID, code, unknownCreate)
    const record = changed.value?.record ?? null
    const childID = record?.childSessionID ?? attempt.childSessionID
    if (childID === null || record?.stop === "confirmed") return
    const confirmed = await boundedStop(services.client, childID)
    await recordStop(parentID, attempt.id, attempt.ownerID, confirmed)
    if (!confirmed) reportStopUnconfirmed()
  }

  async function start(args: ReviewStartArgs, context: ToolContext): Promise<ReviewStartResult> {
    try {
      if (disposed) return { status: "error", reason: "disposed" }
      if (!validStartArgs(args)) return { status: "error", reason: "invalid-arguments" }
      const reviewer = services.config.review.reviewer
      if (!services.config.review.enabled || reviewer === undefined) return { status: "disabled" }
      if (context.abort.aborted) return { status: "aborted" }
      if (
        !isNonEmptyString(context.sessionID) ||
        !isNonEmptyString(context.messageID) ||
        !isNonEmptyString(context.agent)
      ) {
        return { status: "error", reason: "invalid-context" }
      }

      const parentID = context.sessionID
      const root = await services.roots.isRoot(parentID, context.abort)
      if (context.abort.aborted) return { status: "aborted" }
      if (!root.ok) return { status: "error", reason: "caller-unavailable" }
      if (!root.value) return { status: "denied", reason: "child-caller" }

      // Lazy recovery: a dispatch is parent activity. Reconcile stored work
      // before deciding whether a new reservation may be created.
      await reconcile(parentID)
      if (context.abort.aborted) return { status: "aborted" }

      const loaded = await services.state.load(parentID)
      if (context.abort.aborted) return { status: "aborted" }
      if (!loaded.ok) return { status: "error", reason: "state-unavailable" }
      if (loaded.value === null) return { status: "conflict", reason: "stale-review" }
      const early = earlyStatus(loaded.value, args)
      if (early !== null) return early

      const reviewContext = await readReviewExecutionContext(
        services.client,
        {
          parentID,
          messageID: context.messageID,
          callerAgent: context.agent,
          reviewerAgent: reviewer.agent,
        },
        context.abort,
      )
      if (context.abort.aborted) return { status: "aborted" }
      if (disposed) return { status: "error", reason: "disposed" }
      if (!reviewContext.ok) return { status: "disabled", reason: "reviewer-unavailable" }

      const transcript = {
        includeToolCalls: reviewer.transcript.includeToolCalls,
        includeToolResults: reviewer.transcript.includeToolResults,
        maxBytes: reviewer.transcript.maxBytes,
      }
      const scope = {
        delegation: "title-review",
        reviewID: args.reviewID,
        reviewerAgent: reviewer.agent,
        timeoutSeconds: reviewer.timeoutSeconds,
        transcript,
      }
      const startAsk = await askFor(context, "stm_title_review_start", [parentID], {
        ...scope,
        authority: "keep-or-rename",
      })
      if (!startAsk.ok) return { status: startAsk.status }
      const taskAsk = await askFor(context, "task", [reviewer.agent], scope)
      if (!taskAsk.ok) return { status: taskAsk.status }
      const reviewAsk = await askFor(context, "stm_title_review", [parentID], {
        ...scope,
        authority: "keep-or-rename",
      })
      if (!reviewAsk.ok) return { status: reviewAsk.status }
      if (disposed) return { status: "error", reason: "disposed" }

      const outcome = await services.guard.run(parentID, async () => {
        if (context.abort.aborted) return { kind: "aborted" as const }
        const live = await readSession(services.client, parentID, context.abort)
        if (context.abort.aborted) return { kind: "aborted" as const }
        if (!live.ok) return { kind: "error" as const }
        if (live.value.title !== args.expectedTitle) {
          return { kind: "conflict" as const, reason: "expected-title-mismatch" }
        }
        const latest = await services.state.load(parentID)
        if (context.abort.aborted) return { kind: "aborted" as const }
        if (!latest.ok) return { kind: "error" as const }
        if (latest.value === null) return { kind: "conflict" as const, reason: "stale-review" }
        const meta = latest.value
        const earlyAgain = earlyStatus(meta, args)
        if (earlyAgain !== null) return { kind: "early" as const, result: earlyAgain }
        if (meta.titleDigest === null || meta.titleDigest !== hashTitle(live.value.title)) {
          return { kind: "conflict" as const, reason: "expected-title-mismatch" }
        }

        const attempt: BackgroundAttempt = {
          id: randomUUID(),
          reviewID: args.reviewID,
          ownerID,
          phase: "active",
          titleDigest: hashTitle(live.value.title),
          cutoffMessageID: context.messageID,
          activityAtDispatch: meta.activity,
          deadline: now() + reviewer.timeoutSeconds * 1000,
          childSessionID: null,
          promptMessageID: null,
          stop: "not-started",
          failureCode: null,
        }
        const reserved = await services.state.updateIfPresent<ReservationStep>(parentID, (current) => {
          // Abort-before-acceptance is decided inside the atomic transaction:
          // an abort while the update is queued must not persist a reservation.
          if (context.abort.aborted) {
            return { next: current, result: { aborted: true as const } }
          }
          const reservedNow = reserveReview(current, attempt, args.retry === true)
          return {
            next: reservedNow.next,
            result: { aborted: false as const, reservation: reservedNow.result },
          }
        })
        if (!reserved.ok) return { kind: "error" as const }
        if (!reserved.present) return { kind: "conflict" as const, reason: "stale-review" }
        if (reserved.value.aborted) return { kind: "aborted" as const }
        return {
          kind: "reserved" as const,
          result: reserved.value.reservation,
          title: live.value.title,
        }
      })

      if (outcome.kind === "aborted") return { status: "aborted" }
      if (outcome.kind === "error") return { status: "error", reason: "state-unavailable" }
      if (outcome.kind === "conflict") return { status: "conflict", reason: outcome.reason }
      if (outcome.kind === "early") return outcome.result
      if (outcome.result.status !== "queued") {
        return outcome.result.status === "conflict"
          ? { status: "conflict", reason: "review-unavailable" }
          : { status: outcome.result.status }
      }
      if (disposed) {
        // Disposal raced acceptance after the reservation was persisted. Revoke
        // it instead of leaving an active reservation with no live worker.
        await revokeState(parentID, outcome.result.attempt.id, ownerID, "background-revoked", false)
        return { status: "aborted" }
      }

      const job: OwnedJob = {
        parentID,
        attempt: outcome.result.attempt,
        agent: reviewContext.value.agent,
        permissions: reviewContext.value.childPermissions,
        reviewer,
        title: outcome.title,
        controller: new AbortController(),
        settled: false,
        applying: false,
        createAttempted: false,
        childID: null,
        promptMessageID: null,
        promptText: null,
        pollTimer: null,
        deadlineTimer: null,
        reconcileQueued: false,
        reconcileWait: Promise.resolve(),
        reconcileChain: Promise.resolve(),
      }
      jobs.set(parentID, job)

      // The deadline covers collection, creation, prompting and result handling.
      const remaining = Math.max(0, job.attempt.deadline - now())
      const deadlineTimer = setTimeout(() => {
        job.deadlineTimer = null
        if (disposed || job.settled) return
        job.controller.abort()
        void failOwnedReview(job, "background-timeout")
      }, remaining)
      deadlineTimer.unref?.()
      job.deadlineTimer = deadlineTimer

      // Caller teardown after this return must not cancel accepted work.
      void runAcceptedReview(job).catch(() => failOwnedReview(job, "background-internal-error"))
      return { status: "queued" }
    } catch {
      return { status: "error", reason: "internal" }
    }
  }

  async function onEvent(event: unknown): Promise<void> {
    if (disposed) return
    try {
      const deleted = deletedSessionID(event)
      if (deleted !== null) {
        // Deletion is the last safe point at which this process can revoke an
        // owned worker before the caller removes its persisted metadata.
        await cancelInternal(deleted, "background-revoked", true)
        for (const job of [...jobs.values()]) {
          if (job.childID === deleted) await childDeleted(job)
        }
        return
      }

      const sessionID = eventSessionID(event)
      if (sessionID === null) return
      for (const job of [...jobs.values()]) {
        if (job.childID === sessionID) void requestReconcile(job)
      }
    } catch {
      // Event delivery must not throw into the global hook.
    }
  }

  async function reconcile(parentID: string): Promise<void> {
    if (disposed || !isNonEmptyString(parentID)) return
    try {
      const loaded = await services.state.load(parentID)
      if (!loaded.ok || loaded.value === null) return
      const meta = loaded.value
      const attempt = meta.backgroundReview
      if (attempt === null || attempt.phase !== "active") return
      if (attempt.ownerID === ownerID) {
        const job = jobs.get(parentID)
        if (job !== undefined && job.attempt.id === attempt.id) return
        // A stored attempt owned by this instance with no live job cannot be
        // resumed safely: revoke authority and never apply its old result.
        await revokeAndStop(parentID, attempt, "background-revoked", true)
        return
      }
      // A foreign owner is not assumed dead before its stored deadline. This
      // lazy check cannot enforce a crashed process's timer: a child may outlive
      // the stored deadline until a later parent activity or dispatch reconciles
      // it, and an unconfirmed stop continues to block replacement.
      if (now() < attempt.deadline) return
      await revokeAndStop(parentID, attempt, "background-revoked", true)
    } catch {
      // Reconciliation is best effort; a later dispatch or activity retries it.
    }
  }

  async function cancelInternal(
    parentID: string,
    reason: string,
    allowActiveForeign: boolean,
  ): Promise<void> {
    if (disposed || !isNonEmptyString(parentID)) return
    try {
      const job = jobs.get(parentID)
      const extraChildID = job?.childID ?? null
      if (job !== undefined) {
        job.settled = true
        clearTimers(job)
        job.promptText = null
        job.controller.abort()
        removeJob(job)
      }

      const loaded = await services.state.load(parentID)
      const persisted = loaded.ok ? loaded.value?.backgroundReview ?? null : null
      const currentAttempt = persisted ?? job?.attempt ?? null
      if (currentAttempt === null) {
        // The record may already be gone; still stop a child known to this job.
        if (extraChildID !== null) {
          const confirmed = await boundedStop(services.client, extraChildID)
          if (!confirmed) reportStopUnconfirmed()
        }
        return
      }

      if (currentAttempt.ownerID !== ownerID) {
        // A foreign reservation owns mutation authority until an explicit
        // transition revokes it. Once the shared record is terminal, or on an
        // explicit parent deletion, this instance may stop the persisted child
        // without writing or reclaiming authority. Ordinary reconciliation
        // never calls this path and therefore never steals a live reservation.
        const explicitlyRevoked =
          currentAttempt.phase === "failed" || currentAttempt.phase === "uncertain"
        if (persisted !== null && (explicitlyRevoked || allowActiveForeign)) {
          let record = persisted
          if (allowActiveForeign && persisted.phase === "active") {
            // Deletion itself ends the foreign reservation. Revoke through the
            // same attempt/owner transition, then stop the known child before
            // the caller removes shared metadata.
            const changed = await revokeState(
              parentID,
              persisted.id,
              persisted.ownerID,
              reason,
              false,
            )
            const current = changed.value?.record ?? null
            if (
              current === null ||
              current.id !== persisted.id ||
              current.ownerID !== persisted.ownerID ||
              current.childSessionID !== persisted.childSessionID
            ) {
              // Authority or the bound child changed while deletion was
              // delivered. Never stop or rewrite a replacement attempt.
              return
            }
            record = current
          }
          const childID = persisted.childSessionID ?? extraChildID
          if (childID !== null && record.stop !== "confirmed") {
            const confirmed = await boundedStop(services.client, childID)
            await recordStop(
              parentID,
              persisted.id,
              persisted.ownerID,
              confirmed,
              persisted.childSessionID,
            )
            if (!confirmed) reportStopUnconfirmed()
          }
          return
        }
        // Not explicitly revoked: stop only a child this local job knew about.
        if (extraChildID !== null) {
          const confirmed = await boundedStop(services.client, extraChildID)
          if (!confirmed) reportStopUnconfirmed()
        }
        return
      }

      const childID = extraChildID ?? currentAttempt.childSessionID
      if (currentAttempt.phase === "uncertain") {
        if (childID !== null && currentAttempt.stop !== "confirmed") {
          const confirmed = await boundedStop(services.client, childID)
          if (confirmed) {
            await recordStop(
              parentID,
              currentAttempt.id,
              currentAttempt.ownerID,
              true,
              currentAttempt.childSessionID,
            )
          } else {
            reportStopUnconfirmed()
          }
        }
        return
      }
      if (currentAttempt.phase !== "active" && currentAttempt.phase !== "failed") return

      const unknownCreate = job?.createAttempted === true && childID === null
      const changed = await revokeState(
        parentID,
        currentAttempt.id,
        currentAttempt.ownerID,
        reason,
        unknownCreate,
      )
      const record = changed.value?.record ?? null
      if (record?.stop === "confirmed") return
      const stopID = childID ?? record?.childSessionID ?? null
      if (stopID === null) return
      const confirmed = await boundedStop(services.client, stopID)
      await recordStop(
        parentID,
        currentAttempt.id,
        currentAttempt.ownerID,
        confirmed,
        currentAttempt.childSessionID,
      )
      if (!confirmed) reportStopUnconfirmed()
    } catch {
      // Cancellation is best effort; the persisted reservation remains
      // authoritative and cannot be applied after revocation.
    }
  }

  async function cancel(parentID: string, reason: string): Promise<void> {
    await cancelInternal(parentID, reason, false)
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    const snapshot = [...jobs.values()]
    for (const job of snapshot) {
      // Stop new application immediately, but keep timers inert until persisted
      // revocation and the fresh remote-stop attempt have run.
      job.settled = true
      job.promptText = null
      job.controller.abort()
      jobs.delete(job.parentID)
    }

    for (const job of snapshot) {
      try {
        const loaded = await services.state.load(job.parentID)
        const storedAttempt = loaded.ok ? loaded.value?.backgroundReview ?? null : null
        const currentAttempt = storedAttempt ?? job.attempt
        const childID = job.childID ?? currentAttempt.childSessionID

        if (storedAttempt === null || storedAttempt.ownerID !== ownerID) {
          // No matching stored authority. Stop any child this instance still
          // knows about, but never recreate missing metadata.
          if (childID !== null) {
            const confirmed = await boundedStop(services.client, childID)
            if (!confirmed) reportStopUnconfirmed()
          }
          continue
        }

        if (storedAttempt.phase === "uncertain") {
          if (childID !== null && storedAttempt.stop !== "confirmed") {
            const confirmed = await boundedStop(services.client, childID)
            if (confirmed) await recordStop(job.parentID, storedAttempt.id, storedAttempt.ownerID, true)
            else reportStopUnconfirmed()
          }
          continue
        }
        if (storedAttempt.phase !== "active" && storedAttempt.phase !== "failed") continue

        const changed = await revokeState(
          job.parentID,
          storedAttempt.id,
          storedAttempt.ownerID,
          "background-revoked",
          job.createAttempted && childID === null,
        )
        const record = changed.value?.record ?? null
        if (childID !== null && record?.stop !== "confirmed") {
          const confirmed = await boundedStop(services.client, childID)
          await recordStop(job.parentID, storedAttempt.id, storedAttempt.ownerID, confirmed)
          if (!confirmed) reportStopUnconfirmed()
        }
      } catch {
        // Disposal revokes first and contains all cleanup errors.
      }
    }
    for (const job of snapshot) clearTimers(job)
  }

  return { start, onEvent, reconcile, cancel, dispose }
}
