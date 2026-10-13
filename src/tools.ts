import { randomUUID } from "node:crypto"
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { StmConfig } from "./config.js"
import { initialMeta, hashTitle, type SessionMeta, type StateStore, type OperationGuard } from "./state.js"
import { page, readSession, writeTitle, type Client, type RootCache } from "./sdk.js"
import { ENVELOPE_BUDGET_REASON, extractVisibleText, type SupplyResult, type TranscriptPager } from "./transcript.js"
import { firstObservation, isDefaultTitle, lockExternal, lockManually, resolveReview, unlock } from "./scheduler.js"

export const TITLE_MAX_CODE_POINTS = 120
const TITLE_DISPLAY_MAX = 200
const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/u

export type TitleValidation = { ok: true; value: string } | { ok: false; reason: string }

export function validateTitle(raw: string): TitleValidation {
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: "title-empty" }
  if ([...value].length > TITLE_MAX_CODE_POINTS) return { ok: false, reason: "title-too-long" }
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, reason: "title-control-characters" }
  return { ok: true, value }
}

export type StmServices = {
  client: Client
  config: StmConfig
  state: StateStore
  transcripts: TranscriptPager
  roots: RootCache
  guard: OperationGuard
  blocked: Map<string, Set<string>>
  now: () => number
}

function status(value: Record<string, unknown>): string {
  return JSON.stringify({ plugin: "opencode-stm", ...value })
}

function titleForStatus(title: string): { value: string; truncated: boolean } {
  const points = [...title]
  if (points.length <= TITLE_DISPLAY_MAX) return { value: title, truncated: false }
  return { value: `${points.slice(0, TITLE_DISPLAY_MAX).join("")}…`, truncated: true }
}

async function requireRootCaller(
  services: StmServices,
  context: ToolContext,
): Promise<{ ok: true } | { ok: false; status: string }> {
  const root = await services.roots.isRoot(context.sessionID, context.abort)
  if (!root.ok) return { ok: false, status: "error" }
  if (!root.value) return { ok: false, status: "unsupported-child-session" }
  return { ok: true }
}

async function askOrAbort(
  context: ToolContext,
  permission: string,
  target: string,
  metadata: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; status: "denied" | "aborted" }> {
  if (context.abort.aborted) return { ok: false, status: "aborted" }
  try {
    await context.ask({ permission, patterns: [target], always: [], metadata })
  } catch {
    return { ok: false, status: context.abort.aborted ? "aborted" : "denied" }
  }
  if (context.abort.aborted) return { ok: false, status: "aborted" }
  return { ok: true }
}

export async function establishBaseline(
  services: StmServices,
  sessionID: string,
  signal?: AbortSignal,
  knownTitle?: string,
): Promise<{ ok: true; meta: SessionMeta } | { ok: false; reason: string }> {
  const loaded = await services.state.load(sessionID)
  if (!loaded.ok) return { ok: false, reason: loaded.reason }
  if (loaded.value !== null) return { ok: true, meta: loaded.value }
  let title = knownTitle
  if (title === undefined) {
    const read = await readSession(services.client, sessionID, signal)
    if (!read.ok) return { ok: false, reason: read.reason }
    title = read.value.title
  }
  const meta = firstObservation(isDefaultTitle(title), hashTitle(title))
  // Transition atomically against the latest persisted metadata: a concurrent
  // lock (or any other write) that landed since the initial load must win
  // instead of being overwritten by this baseline.
  const updated = await services.state.update(sessionID, (current) => {
    const next = current ?? meta
    return { next, result: next }
  })
  if (!updated.ok) return { ok: false, reason: updated.reason }
  return { ok: true, meta: updated.value }
}

export function createCurrentTools(services: StmServices): Record<string, ToolDefinition> {
  const titleRead = tool({
    description: "Read the current session title, lock state and pending title review ID.",
    args: {},
    async execute(_args, context) {
      if (context.abort.aborted) return status({ status: "aborted" })
      const caller = await requireRootCaller(services, context)
      if (!caller.ok) return status({ status: caller.status })
      const read = await readSession(services.client, context.sessionID, context.abort)
      if (!read.ok) return status({ status: "error" })
      const baseline = await establishBaseline(services, context.sessionID, context.abort, read.value.title)
      if (!baseline.ok) return status({ status: "state-unavailable" })
      const shown = titleForStatus(read.value.title)
      return status({
        status: "ok",
        sessionID: context.sessionID,
        title: shown.value,
        titleTruncated: shown.truncated,
        locked: baseline.meta.locked,
        lockReason: baseline.meta.lockReason,
        reviewID: baseline.meta.review?.id ?? null,
      })
    },
  })

  const titleReview = tool({
    description:
      "Resolve the current title review, or apply an explicit keep/rename decision. Keep requires no title; rename requires a new title.",
    args: {
      decision: tool.schema.enum(["keep", "rename"]),
      expectedTitle: tool.schema.string(),
      title: tool.schema.optional(tool.schema.string()),
      reviewID: tool.schema.optional(tool.schema.string()),
    },
    async execute(args, context) {
      if (context.abort.aborted) return status({ status: "aborted" })
      const caller = await requireRootCaller(services, context)
      if (!caller.ok) return status({ status: caller.status })

      let newTitle: string | null = null
      if (args.decision === "rename") {
        if (args.title === undefined) return status({ status: "invalid", reason: "title-required" })
        const valid = validateTitle(args.title)
        if (!valid.ok) return status({ status: "invalid", reason: valid.reason })
        newTitle = valid.value
      } else if (args.title !== undefined) {
        return status({ status: "invalid", reason: "title-not-allowed" })
      }

      const loaded = await services.state.load(context.sessionID)
      if (!loaded.ok) return status({ status: "state-unavailable" })
      const read = await readSession(services.client, context.sessionID, context.abort)
      if (!read.ok) return status({ status: "error" })
      const currentTitle = read.value.title
      let meta = loaded.value
      if (meta === null) {
        const baseline = await establishBaseline(services, context.sessionID, context.abort, currentTitle)
        if (!baseline.ok) return status({ status: "state-unavailable" })
        meta = baseline.meta
      }
      if (args.reviewID !== undefined && (meta.review === null || meta.review.id !== args.reviewID)) {
        return status({ status: "conflict", reason: "stale-review" })
      }
      if (currentTitle !== args.expectedTitle) {
        return status({ status: "conflict", reason: "expected-title-mismatch" })
      }
      if (meta.titleDigest !== null && hashTitle(currentTitle) !== meta.titleDigest) {
        // The comparison above used the pre-read snapshot: a concurrent unlock
        // (or any other transition) may have established the current digest
        // while that read was pending. Re-evaluate the mismatch under the same
        // guard as the mutating tools, against the latest persisted state and a
        // fresh title read: only an unattributed difference that is still
        // present on the latest state locks the session; a verified explicit
        // unlock is preserved and an already-locked state is never overwritten.
        const external = await services.guard.run(
          context.sessionID,
          async (): Promise<{ ok: true; locked: boolean } | { ok: false; status: "aborted" | "error" | "uncertain" }> => {
            if (context.abort.aborted) return { ok: false, status: "aborted" }
            const read = await readSession(services.client, context.sessionID, context.abort)
            if (context.abort.aborted) return { ok: false, status: "aborted" }
            if (!read.ok) return { ok: false, status: "error" }
            const saved = await services.state.update(context.sessionID, (current) => {
              const base = current ?? meta
              if (base.locked) return { next: base, result: true }
              if (base.titleDigest === null || hashTitle(read.value.title) === base.titleDigest) {
                return { next: base, result: false }
              }
              return { next: lockExternal(base), result: true }
            })
            if (!saved.ok) return { ok: false, status: "uncertain" }
            return { ok: true, locked: saved.value }
          },
        )
        if (!external.ok) {
          if (external.status === "aborted") return status({ status: "aborted" })
          if (external.status === "error") return status({ status: "error" })
          return status({ status: "uncertain", reason: "state-save-failed" })
        }
        if (external.locked) return status({ status: "locked", reason: "external-title-change" })
      }

      if (args.decision === "keep") {
        const approved = await askOrAbort(context, "stm_title_review", context.sessionID, { decision: "keep" })
        if (!approved.ok) return status({ status: approved.status })
        // Serialise the confirmation and resolution with rename's guarded
        // read-check-mutate (never nested): the title may have changed while the
        // ask was pending, and a review resolved, cleared or replaced during the
        // ask must not be resolved by this stale call.
        const outcome = await services.guard.run(
          context.sessionID,
          async (): Promise<
            { ok: true; reviewID: string | null } | { ok: false; status: "aborted" | "error" | "conflict" | "uncertain"; reason?: string }
          > => {
            const confirm = await readSession(services.client, context.sessionID, context.abort)
            if (context.abort.aborted) return { ok: false, status: "aborted" }
            if (!confirm.ok) return { ok: false, status: "error" }
            if (confirm.value.title !== args.expectedTitle) {
              return { ok: false, status: "conflict", reason: "expected-title-mismatch" }
            }
            let resolvedReviewID: string | null = null
            const saved = await services.state.update(context.sessionID, (current) => {
              const base = current ?? meta
              // Revalidate the caller-provided review ID against the latest
              // state: resolving, clearing or replacing the review while the ask
              // was pending conflicts instead of resolving a review the caller
              // never saw.
              if (args.reviewID !== undefined && (base.review?.id ?? null) !== args.reviewID) {
                return { next: base, result: false }
              }
              resolvedReviewID = base.review?.id ?? null
              // Resolve against the latest metadata so a lock that landed
              // during the ask is preserved rather than erased.
              return { next: resolveReview(base, hashTitle(confirm.value.title)), result: true }
            })
            if (!saved.ok) return { ok: false, status: "uncertain", reason: "state-save-failed" }
            if (saved.value === false) return { ok: false, status: "conflict", reason: "stale-review" }
            return { ok: true, reviewID: resolvedReviewID }
          },
        )
        if (!outcome.ok) {
          if (outcome.status === "conflict") {
            return status({ status: "conflict", reason: outcome.reason ?? "expected-title-mismatch" })
          }
          if (outcome.status === "uncertain") return status({ status: "uncertain", reason: outcome.reason })
          return status({ status: outcome.status === "aborted" ? "aborted" : "error" })
        }
        return status({ status: "ok", decision: "keep", reviewID: outcome.reviewID })
      }

      if (meta.locked) return status({ status: "conflict", reason: "locked" })
      if (newTitle === null) return status({ status: "error" })

      const approved = await askOrAbort(context, "stm_title_review", context.sessionID, {
        currentTitle,
        newTitle,
      })
      if (!approved.ok) return status({ status: approved.status })

      const outcome = await services.guard.run(context.sessionID, async () => {
        const before = await readSession(services.client, context.sessionID, context.abort)
        if (context.abort.aborted) return { outcome: "aborted" as const }
        if (!before.ok) return { outcome: "error" as const }
        if (before.value.title !== args.expectedTitle) return { outcome: "conflict" as const }
        // A lock mutation (or another guarded transition) may have completed
        // while the permission ask was pending: never write over a lock.
        const latest = await services.state.load(context.sessionID)
        if (context.abort.aborted) return { outcome: "aborted" as const }
        if (!latest.ok) return { outcome: "state-unavailable" as const }
        const effective = latest.value ?? meta
        if (effective.locked) return { outcome: "conflict" as const, reason: "locked" as const }
        // Revalidate the caller-provided review ID against the latest state: a
        // review resolved or replaced while the ask was pending must conflict
        // instead of writing a title for a review the caller never saw.
        if (args.reviewID !== undefined && (effective.review?.id ?? null) !== args.reviewID) {
          return { outcome: "conflict" as const, reason: "stale-review" as const }
        }
        const written = await writeTitle(services.client, context.sessionID, newTitle!, context.abort)
        // The write may have landed even though the caller aborted: report the
        // partial result and stop. No read-back, no state change, no retry.
        if (context.abort.aborted) return { outcome: "uncertain" as const, reason: "aborted-during-write" as const }
        if (!written.ok) return { outcome: "error" as const }
        const after = await readSession(services.client, context.sessionID, context.abort)
        if (context.abort.aborted) return { outcome: "uncertain" as const, reason: "aborted-during-write" as const }
        if (!after.ok || after.value.title !== newTitle) return { outcome: "uncertain" as const }
        return { outcome: "renamed" as const, title: after.value.title }
      })
      if (outcome.outcome !== "renamed") {
        if (outcome.outcome === "conflict") {
          return status({ status: "conflict", reason: "reason" in outcome ? outcome.reason : "expected-title-mismatch" })
        }
        return "reason" in outcome
          ? status({ status: outcome.outcome, reason: outcome.reason })
          : status({ status: outcome.outcome })
      }
      const saved = await services.state.update(context.sessionID, (current) => ({
        next: resolveReview(current ?? meta, hashTitle(outcome.title)),
        result: true,
      }))
      if (!saved.ok) return status({ status: "uncertain", reason: "state-save-failed" })
      return status({ status: "ok", decision: "rename", title: outcome.title })
    },
  })

  const titleLock = tool({
    description: "Lock (pause) or unlock periodic title reviews for the current session.",
    args: { locked: tool.schema.boolean(), expectedTitle: tool.schema.string() },
    async execute(args, context) {
      if (context.abort.aborted) return status({ status: "aborted" })
      const caller = await requireRootCaller(services, context)
      if (!caller.ok) return status({ status: caller.status })
      const loaded = await services.state.load(context.sessionID)
      if (!loaded.ok) return status({ status: "state-unavailable" })
      const approved = await askOrAbort(context, "stm_title_lock", context.sessionID, {})
      if (!approved.ok) return status({ status: approved.status })
      // Serialise the whole read-check-mutate sequence with rename's guarded
      // read-check-write. The title must be read inside the guard: a rename that
      // held the guard may have changed it while this call was queued, and the
      // unlock digest must derive from the title actually confirmed here.
      const outcome = await services.guard.run(
        context.sessionID,
        async (): Promise<
          { ok: true; locked: boolean } | { ok: false; status: "aborted" | "error" | "conflict" | "uncertain" }
        > => {
          if (context.abort.aborted) return { ok: false, status: "aborted" }
          const read = await readSession(services.client, context.sessionID, context.abort)
          if (context.abort.aborted) return { ok: false, status: "aborted" }
          if (!read.ok) return { ok: false, status: "error" }
          if (read.value.title !== args.expectedTitle) return { ok: false, status: "conflict" }
          const confirmedTitle = read.value.title
          const result = await services.state.update(context.sessionID, (current) => {
            const base = current ?? loaded.value ?? initialMeta()
            const next = args.locked ? lockManually(base) : unlock(base, hashTitle(confirmedTitle))
            return { next, result: next.locked }
          })
          if (!result.ok) return { ok: false, status: "uncertain" }
          return { ok: true, locked: result.value }
        },
      )
      if (!outcome.ok) {
        if (outcome.status === "aborted") return status({ status: "aborted" })
        if (outcome.status === "error") return status({ status: "error" })
        if (outcome.status === "conflict") {
          return status({ status: "conflict", reason: "expected-title-mismatch" })
        }
        return status({ status: "uncertain", reason: "state-save-failed" })
      }
      return status({ status: "ok", locked: outcome.locked })
    },
  })

  return { stm_title_read: titleRead, stm_title_review: titleReview, stm_title_lock: titleLock }
}

function isBlocked(services: StmServices, caller: string, target: string): boolean {
  return services.blocked.get(caller)?.has(target) ?? false
}

function blockTarget(services: StmServices, caller: string, target: string): void {
  const targets = services.blocked.get(caller) ?? new Set<string>()
  targets.add(target)
  services.blocked.set(caller, targets)
}

export function createHistoricalTools(services: StmServices): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {}

  if (services.config.historical.readTitles) {
    tools.stm_history_title_read = tool({
      description: "Opt-in read of one other session's title and root/child metadata. Does not traverse.",
      args: { sessionID: tool.schema.string() },
      async execute(args, context) {
        if (context.abort.aborted) return status({ status: "aborted" })
        if (args.sessionID === context.sessionID) return status({ status: "invalid", reason: "self-target" })
        const caller = await requireRootCaller(services, context)
        if (!caller.ok) return status({ status: caller.status })
        const approved = await askOrAbort(context, "stm_history_title_read", args.sessionID, {})
        if (!approved.ok) return status({ status: approved.status })
        const read = await readSession(services.client, args.sessionID, context.abort)
        if (!read.ok) return status({ status: "error" })
        const shown = titleForStatus(read.value.title)
        return status({
          status: "ok",
          sessionID: read.value.id,
          title: shown.value,
          titleTruncated: shown.truncated,
          root: read.value.parentID === undefined,
        })
      },
    })
  }

  if (services.config.historical.renameTitles) {
    tools.stm_history_title_rename = tool({
      description:
        "Opt-in explicit rename of one other root session. Reads back for verification and leaves the target's automatic review locked.",
      args: { sessionID: tool.schema.string(), expectedTitle: tool.schema.string(), title: tool.schema.string() },
      async execute(args, context) {
        if (context.abort.aborted) return status({ status: "aborted" })
        if (args.sessionID === context.sessionID) return status({ status: "invalid", reason: "self-target" })
        const caller = await requireRootCaller(services, context)
        if (!caller.ok) return status({ status: caller.status })
        if (isBlocked(services, context.sessionID, args.sessionID)) {
          return status({ status: "conflict", reason: "sensitive-blocked" })
        }
        const valid = validateTitle(args.title)
        if (!valid.ok) return status({ status: "invalid", reason: valid.reason })
        const approved = await askOrAbort(context, "stm_history_title_rename", args.sessionID, {
          expectedTitle: args.expectedTitle,
          newTitle: valid.value,
        })
        if (!approved.ok) return status({ status: approved.status })
        // A sensitive review end may have completed while the ask was pending:
        // revalidate before any target read or write.
        if (isBlocked(services, context.sessionID, args.sessionID)) {
          return status({ status: "conflict", reason: "sensitive-blocked" })
        }

        const outcome = await services.guard.run(args.sessionID, async () => {
          const before = await readSession(services.client, args.sessionID, context.abort)
          if (context.abort.aborted) return { outcome: "aborted" as const }
          if (!before.ok) return { outcome: "error" as const }
          // The sensitive stop may have landed while queued on the guard or during
          // the read: never write after it, even though the fast path passed.
          if (isBlocked(services, context.sessionID, args.sessionID)) {
            return { outcome: "conflict" as const, reason: "sensitive-blocked" }
          }
          if (before.value.parentID !== undefined) return { outcome: "conflict" as const, reason: "child-target" }
          if (before.value.title !== args.expectedTitle) {
            return { outcome: "conflict" as const, reason: "expected-title-mismatch" }
          }
          const written = await writeTitle(services.client, args.sessionID, valid.value, context.abort)
          // The write may have landed even though the caller aborted: report the
          // partial result and stop. No read-back, no state change, no retry.
          if (context.abort.aborted) return { outcome: "uncertain" as const, reason: "aborted-during-write" }
          if (!written.ok) return { outcome: "error" as const }
          const after = await readSession(services.client, args.sessionID, context.abort)
          if (context.abort.aborted) return { outcome: "uncertain" as const, reason: "aborted-during-write" }
          if (!after.ok || after.value.title !== valid.value) return { outcome: "uncertain" as const }
          return { outcome: "renamed" as const, title: after.value.title }
        })
        if (outcome.outcome !== "renamed") {
          return "reason" in outcome
            ? status({ status: outcome.outcome, reason: outcome.reason })
            : status({ status: outcome.outcome })
        }
        // Lock the target's automatic review against the latest persisted state so a
        // concurrent metadata change is preserved rather than overwritten.
        const saved = await services.state.update(args.sessionID, (current) => {
          const base = current ?? initialMeta()
          return {
            next: { ...base, locked: true, lockReason: "historical", titleDigest: hashTitle(outcome.title) },
            result: true,
          }
        })
        if (!saved.ok) return status({ status: "uncertain", reason: "state-save-failed" })
        return status({ status: "ok", sessionID: args.sessionID, title: outcome.title })
      },
    })
  }

  if (services.config.historical.readTranscript) {
    tools.stm_history_transcript = tool({
      description:
        "Opt-in retrieval of one bounded chunk of another root session's visible user/assistant text, returned directly in this tool result and persisted with the session like any other result. Each result is at most 16 KiB and 1999 lines and carries page, cursor, completion and continuation metadata. Follow the continuation guidance: call again without a cursor for more of the same page, with the returned cursor for the next page, or stop when complete. Never returns reasoning or tool bodies.",
      args: { sessionID: tool.schema.string(), cursor: tool.schema.optional(tool.schema.string()) },
      async execute(args, context) {
        if (context.abort.aborted) return status({ status: "aborted" })
        if (args.sessionID === context.sessionID) return status({ status: "invalid", reason: "self-target" })
        const caller = await requireRootCaller(services, context)
        if (!caller.ok) return status({ status: caller.status })
        if (isBlocked(services, context.sessionID, args.sessionID)) {
          return status({ status: "conflict", reason: "sensitive-blocked" })
        }
        const approved = await askOrAbort(context, "stm_history_transcript", args.sessionID, {})
        if (!approved.ok) return status({ status: approved.status })
        // A sensitive review end may have completed while the ask was pending:
        // revalidate before reading the target or fetching any page.
        if (isBlocked(services, context.sessionID, args.sessionID)) {
          return status({ status: "conflict", reason: "sensitive-blocked" })
        }

        const target = await readSession(services.client, args.sessionID, context.abort)
        if (!target.ok) return status({ status: "error" })
        // The sensitive stop may have landed during the target read.
        if (isBlocked(services, context.sessionID, args.sessionID)) {
          return status({ status: "conflict", reason: "sensitive-blocked" })
        }
        if (target.value.parentID !== undefined) return status({ status: "conflict", reason: "child-target" })

        const begun = services.transcripts.begin({
          callerSessionID: context.sessionID,
          targetSessionID: args.sessionID,
          signal: context.abort,
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        })
        if (!begun.ok) {
          return begun.reason === "pager: aborted"
            ? status({ status: "aborted" })
            : status({ status: "conflict", reason: begun.reason })
        }

        const fetched = await page(services.client, args.sessionID, begun.fetchCursor, context.abort)
        // A failed or aborted read releases its fetch generation and leaves the
        // pager offsets retryable; the release is token-scoped.
        if (context.abort.aborted) {
          services.transcripts.release(context.sessionID, begun.token)
          return status({ status: "aborted" })
        }
        if (!fetched.ok) {
          services.transcripts.release(context.sessionID, begun.token)
          return status({ status: "error" })
        }
        // A sensitive review end may have completed during the fetch: discard the
        // fetched text instead of returning it, scoped to this fetch generation.
        if (isBlocked(services, context.sessionID, args.sessionID)) {
          services.transcripts.release(context.sessionID, begun.token)
          return status({ status: "conflict", reason: "sensitive-blocked" })
        }

        // A malformed page must not wedge the binding: release the fetch
        // generation before letting the unexpected error surface.
        let supplied: SupplyResult
        try {
          supplied = services.transcripts.supply(
            context.sessionID,
            { entries: extractVisibleText(fetched.value.items), nextCursor: fetched.value.nextCursor },
            begun.token,
          )
        } catch (error) {
          services.transcripts.release(context.sessionID, begun.token)
          throw error
        }
        if (!supplied.ok) {
          if (supplied.reason === "pager: aborted") return status({ status: "aborted" })
          if (supplied.reason === ENVELOPE_BUDGET_REASON) return status({ status: "error", reason: supplied.reason })
          return status({ status: "conflict", reason: supplied.reason })
        }
        // A successful synchronous supply committed the offsets and detached the
        // request abort listener before returning, so the text is part of this
        // result and the host's post-success signal teardown cannot cancel the
        // next continuation.
        return supplied.output
      },
    })

    tools.stm_history_review_end = tool({
      description:
        "End this caller's review of a target and discard STM's pagination state. A sensitive outcome blocks further transcript reads and renames of that target. Previously returned transcript results remain in session history and are not erased.",
      args: { sessionID: tool.schema.string(), outcome: tool.schema.enum(["reviewed", "sensitive", "cancelled"]) },
      async execute(args, context) {
        if (context.abort.aborted) return status({ status: "aborted" })
        if (args.sessionID === context.sessionID) return status({ status: "invalid", reason: "self-target" })
        const caller = await requireRootCaller(services, context)
        if (!caller.ok) return status({ status: caller.status })
        const approved = await askOrAbort(context, "stm_history_review_end", args.sessionID, {
          outcome: args.outcome,
        })
        if (!approved.ok) return status({ status: approved.status })
        const ended = services.transcripts.endReview(context.sessionID, args.sessionID)
        if (!ended.ok) return status({ status: "conflict", reason: ended.reason })
        if (args.outcome === "sensitive") blockTarget(services, context.sessionID, args.sessionID)
        return status({ status: "ok", outcome: args.outcome })
      },
    })
  }

  return tools
}
