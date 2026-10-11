import { createHash, randomUUID } from "node:crypto"
import type { PageMessage } from "./sdk.js"

export const CHUNK_BYTES = 16 * 1024
export const QUEUE_TTL_MS = 60_000
export const QUEUE_MAX_CALLERS = 16

export type TextEntry = { messageID: string; text: string }

export function extractVisibleText(items: PageMessage[]): TextEntry[] {
  const entries: TextEntry[] = []
  for (const item of items) {
    const role = item.info.role
    if (role !== "user" && role !== "assistant") continue
    if (item.info.summary !== undefined) continue
    for (const part of item.parts) {
      if (part.type !== "text" || part.synthetic === true || part.ignored === true) continue
      if (typeof part.text !== "string" || part.text.length === 0) continue
      entries.push({ messageID: item.info.id, text: part.text })
    }
  }
  return entries
}

function safeCut(encoded: Buffer, limit: number): number {
  let end = Math.min(limit, encoded.byteLength)
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1
  return end
}

export function splitUtf8(text: string, maxBytes: number = CHUNK_BYTES): { chunk: string; rest: string } {
  if (maxBytes < 4) throw new RangeError("maxBytes must hold at least one code point")
  const encoded = Buffer.from(text, "utf8")
  if (encoded.byteLength <= maxBytes) return { chunk: text, rest: "" }
  const end = safeCut(encoded, maxBytes)
  return { chunk: encoded.subarray(0, end).toString("utf8"), rest: encoded.subarray(end).toString("utf8") }
}

export type PendingChunk = {
  id: string
  callerSessionID: string
  targetSessionID: string
  requestMessageID: string
  text: string
  cursorLabel: string | null
  page: number
  complete: boolean
  createdAt: number
  expiresAt: number
}

type CallerState = {
  targetSessionID: string
  requestMessageID: string
  // Opaque generation token for the fetch currently owning this binding. Every
  // successful begin rotates it; supply and release must present it.
  requestToken: string
  pageCursor: string | undefined
  entryIndex: number
  byteOffset: number
  pageExhausted: boolean
  nextPageCursor: string | null
  issuedCursor: string | null
  complete: boolean
  page: number
  pageDigest: string | null
  pending: PendingChunk | null
  // Set when an expiry is observed on this binding. The expired chunk's raw text
  // is unrecoverable, so the stored offsets and cursors would silently skip the
  // lost content: begins are rejected until the caller explicitly ends the
  // review, and the restart refetches from the first page.
  expired: boolean
  signal?: AbortSignal
  abortListener?: () => void
  updatedAt: number
}

export type BeginInput = {
  callerSessionID: string
  targetSessionID: string
  requestMessageID: string
  cursor?: string
  signal?: AbortSignal
}

export type BeginResult =
  | { ok: true; token: string; fetchCursor: string | undefined }
  | { ok: false; reason: string }

export type QueueAck = {
  targetSessionID: string
  messages: number
  bytes: number
  cursor: string | null
  more: boolean
  complete: boolean
  continuation: boolean
}

export type SupplyResult = { ok: true; ack: QueueAck } | { ok: false; reason: string }

export type HandoffResult = { ok: true } | { ok: false; reason: string }

export type EndReviewResult = { ok: true } | { ok: false; reason: string }

export interface TranscriptQueue {
  begin(input: BeginInput, now: number): BeginResult
  supply(
    callerSessionID: string,
    page: { entries: TextEntry[]; nextCursor: string | null },
    now: number,
    token: string,
  ): SupplyResult
  take(callerSessionID: string, now: number): PendingChunk | null
  release(callerSessionID: string, token: string): boolean
  handoff(callerSessionID: string, token: string): HandoffResult
  endReview(callerSessionID: string, targetSessionID: string): EndReviewResult
  discardCaller(callerSessionID: string): void
  has(callerSessionID: string): boolean
  size(): number
  dispose(): void
}

export function createTranscriptQueue(options: { ttlMs?: number; maxCallers?: number } = {}): TranscriptQueue {
  const ttlMs = options.ttlMs ?? QUEUE_TTL_MS
  // A caller-tunable capacity may only lower the hard cap: valid positive integers
  // above QUEUE_MAX_CALLERS are clamped, any other value fails closed with a
  // deterministic error instead of silently disabling the cap.
  const requested = options.maxCallers
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
    throw new RangeError("maxCallers must be a positive integer")
  }
  const maxCallers = requested === undefined ? QUEUE_MAX_CALLERS : Math.min(requested, QUEUE_MAX_CALLERS)
  const states = new Map<string, CallerState>()

  // Expiry is an eligibility deadline, not a real-time erase: an expired chunk may
  // stay in RAM until the next queue operation. Every begin sweeps all callers so
  // unused buffers are released without any timer or background wakeup.
  function purgeExpired(state: CallerState | undefined, now: number): void {
    if (state !== undefined && state.pending !== null && now >= state.pending.expiresAt) {
      state.pending = null
      detachAbort(state)
      // Observed expiry ends the fetch attempt: a late duplicate supply must use a
      // fresh begin instead of resurrecting the expired request.
      state.requestToken = randomUUID()
      // Fail closed: the undelivered chunk cannot be recovered, so the advanced
      // entryIndex/byteOffset/cursor must never be resumed — a continuation would
      // silently skip the lost content. Mark the binding expired and refuse
      // begins until an explicit endReview; only then can the caller restart the
      // review and refetch from the first page.
      state.expired = true
    }
  }

  // Observed expiry releases both raw content and the listener on its signal.
  function purgeExpiredAll(now: number): void {
    for (const state of states.values()) purgeExpired(state, now)
  }

  function detachAbort(state: CallerState): void {
    if (state.signal !== undefined && state.abortListener !== undefined) {
      state.signal.removeEventListener("abort", state.abortListener)
    }
    delete state.signal
    delete state.abortListener
  }

  // Every successful begin is a new request generation: the previous signal is
  // always detached first so aborting a stale request cannot clear the newest
  // binding, even when the new begin carries no signal of its own.
  function setRequestSignal(callerSessionID: string, state: CallerState, signal: AbortSignal | undefined): void {
    detachAbort(state)
    if (signal === undefined) return
    const listener = () => {
      const live = states.get(callerSessionID)
      if (live !== undefined) {
        live.pending = null
        detachAbort(live)
        // Invalidate the request binding too: a late fetch cannot supply it.
        states.delete(callerSessionID)
      }
    }
    state.signal = signal
    state.abortListener = listener
    signal.addEventListener("abort", listener, { once: true })
  }

  // Tagged and length-prefixed so no cursor value (including the literal "end")
  // can collide with the null cursor marker, and adjacent fields cannot alias.
  function digestPage(page: { entries: TextEntry[]; nextCursor: string | null }): string {
    const hash = createHash("sha256")
    hash.update("stm-page-v1;")
    for (const entry of page.entries) {
      const idBytes = Buffer.from(entry.messageID, "utf8")
      const textBytes = Buffer.from(entry.text, "utf8")
      hash.update(`id:${idBytes.byteLength}:`)
      hash.update(idBytes)
      hash.update(`;text:${textBytes.byteLength}:`)
      hash.update(textBytes)
      hash.update(";")
    }
    hash.update(`cursor:${JSON.stringify(page.nextCursor)}`)
    return hash.digest("hex")
  }

  return {
    begin(input, now) {
      purgeExpiredAll(now)
      if (input.signal !== undefined && input.signal.aborted) {
        return { ok: false, reason: "queue: aborted" }
      }
      const state = states.get(input.callerSessionID)
      if (state !== undefined && state.pending !== null) {
        return { ok: false, reason: "queue: chunk pending delivery" }
      }
      if (state !== undefined && state.expired) {
        return { ok: false, reason: "queue: chunk expired; end the review and restart" }
      }
      if (state !== undefined && state.targetSessionID !== input.targetSessionID) {
        return { ok: false, reason: "queue: target binding mismatch; end review first" }
      }
      if (state === undefined) {
        if (input.cursor !== undefined) return { ok: false, reason: "queue: unknown cursor" }
        if (states.size >= maxCallers) return { ok: false, reason: "queue: too many callers" }
        const created: CallerState = {
          targetSessionID: input.targetSessionID,
          requestMessageID: input.requestMessageID,
          requestToken: randomUUID(),
          pageCursor: undefined,
          entryIndex: 0,
          byteOffset: 0,
          pageExhausted: false,
          nextPageCursor: null,
          issuedCursor: null,
          complete: false,
          page: 1,
          pageDigest: null,
          pending: null,
          expired: false,
          updatedAt: now,
        }
        states.set(input.callerSessionID, created)
        setRequestSignal(input.callerSessionID, created, input.signal)
        return { ok: true, token: created.requestToken, fetchCursor: undefined }
      }
      if (state.complete) return { ok: false, reason: "queue: end of history" }
      const normalized = input.cursor ?? null
      if (normalized !== state.issuedCursor) {
        return { ok: false, reason: "queue: cursor not issued to this caller/target" }
      }
      setRequestSignal(input.callerSessionID, state, input.signal)
      // A new fetch owns the binding from here: the previous token is stale.
      state.requestToken = randomUUID()
      if (input.cursor !== undefined && state.pageExhausted) {
        state.pageCursor = input.cursor
        state.entryIndex = 0
        state.byteOffset = 0
        state.pageExhausted = false
        state.nextPageCursor = null
        state.page += 1
        state.pageDigest = null
        state.requestMessageID = input.requestMessageID
        state.updatedAt = now
        return { ok: true, token: state.requestToken, fetchCursor: input.cursor }
      }
      state.requestMessageID = input.requestMessageID
      state.updatedAt = now
      return { ok: true, token: state.requestToken, fetchCursor: state.pageCursor }
    },

    supply(callerSessionID, page, now, token) {
      const state = states.get(callerSessionID)
      if (state === undefined) return { ok: false, reason: "queue: not started" }
      purgeExpired(state, now)
      if (token !== state.requestToken) {
        // A response from a superseded, released, delivered, expired or aborted
        // fetch must never enter the current binding.
        return { ok: false, reason: "queue: stale request" }
      }
      if (state.signal !== undefined && state.signal.aborted) {
        // An aborted call must never queue text, even if the caller forgot to check.
        state.pending = null
        detachAbort(state)
        return { ok: false, reason: "queue: aborted" }
      }
      if (state.pending !== null) return { ok: false, reason: "queue: chunk pending delivery" }

      const digest = digestPage(page)
      const resumingPartially = state.entryIndex > 0 || state.byteOffset > 0
      if (resumingPartially && state.pageDigest !== null && digest !== state.pageDigest) {
        // The page changed under the stored offsets (new messages or edited text).
        // Fail closed, drop the caller binding and require an explicit restart with
        // no cursor; never guess, skip or mislabel content.
        detachAbort(state)
        states.delete(callerSessionID)
        return { ok: false, reason: "queue: page changed; restart the transcript review" }
      }

      let index = state.entryIndex
      let offset = state.byteOffset
      let bytes = 0
      let messages = 0
      const pieces: string[] = []

      while (index < page.entries.length) {
        const entry = page.entries[index]!
        const encoded = Buffer.from(entry.text, "utf8")
        const remaining = encoded.subarray(Math.min(offset, encoded.byteLength))
        if (remaining.byteLength === 0) {
          offset = 0
          index += 1
          continue
        }
        const separator = pieces.length === 0 ? "" : "\n"
        const separatorBytes = Buffer.byteLength(separator, "utf8")
        const available = CHUNK_BYTES - bytes - separatorBytes
        if (available <= 0) break
        const cut = safeCut(remaining, available)
        if (cut === 0) break
        pieces.push(separator + remaining.subarray(0, cut).toString("utf8"))
        bytes += separatorBytes + cut
        offset += cut
        if (offset < encoded.byteLength) break
        index += 1
        offset = 0
        messages += 1
      }

      if (index >= page.entries.length) {
        state.entryIndex = index
        state.byteOffset = 0
        if (page.nextCursor !== null) {
          state.pageExhausted = true
          state.nextPageCursor = page.nextCursor
          state.issuedCursor = page.nextCursor
        } else {
          state.complete = true
          state.issuedCursor = null
        }
      } else {
        state.entryIndex = index
        state.byteOffset = offset
        state.issuedCursor = null
      }
      // Retain only the digest, never raw page text. A partially consumed page keeps
      // its digest so the next same-page continuation can detect mutation; an
      // exhausted page clears it because the next page gets its own digest.
      state.pageDigest = index >= page.entries.length ? null : digest
      state.updatedAt = now

      const text = pieces.join("")
      if (text.length > 0) {
        state.pending = {
          id: randomUUID(),
          callerSessionID,
          targetSessionID: state.targetSessionID,
          requestMessageID: state.requestMessageID,
          text,
          cursorLabel: state.pageCursor ?? null,
          page: state.page,
          complete: state.complete,
          createdAt: now,
          expiresAt: now + ttlMs,
        }
      } else {
        // A successful fetch with no visible text has no pending payload to
        // protect: consume the generation exactly like take() so a duplicate
        // supply with the same token fails closed instead of replaying offsets.
        detachAbort(state)
        state.requestToken = randomUUID()
      }
      return {
        ok: true,
        ack: {
          targetSessionID: state.targetSessionID,
          messages,
          bytes,
          cursor: state.issuedCursor,
          more: !state.complete,
          complete: state.complete,
          continuation: text.length > 0,
        },
      }
    },

    take(callerSessionID, now) {
      const state = states.get(callerSessionID)
      if (state === undefined) return null
      purgeExpired(state, now)
      const pending = state.pending
      if (pending === null) return null
      state.pending = null
      detachAbort(state)
      // Delivery ends the fetch attempt: a duplicate late supply cannot inject twice.
      state.requestToken = randomUUID()
      return pending
    },

    release(callerSessionID, token) {
      const state = states.get(callerSessionID)
      if (state === undefined || state.requestToken !== token) return false
      state.pending = null
      detachAbort(state)
      // The fetch attempt is over: late duplicate supplies are stale.
      state.requestToken = randomUUID()
      return true
    },

    handoff(callerSessionID, token) {
      const state = states.get(callerSessionID)
      if (state === undefined) return { ok: false, reason: "queue: not started" }
      if (token !== state.requestToken) return { ok: false, reason: "queue: stale request" }
      if (state.pending === null) return { ok: false, reason: "queue: no pending chunk" }
      // Commit a successful supply: OpenCode 1.18.35 aborts the per-tool signal
      // after every successful tool return, so detaching the listener here keeps
      // the queued chunk and cursor binding for the next transform. Aborts before
      // this handoff still discard via the listener or release(); afterwards
      // cleanup is take/endReview/discardCaller/dispose or the 60 s lazy sweep.
      // A true session cancellation after success is indistinguishable from the
      // host teardown: the chunk is RAM-only, TTL-bounded and never persisted.
      detachAbort(state)
      return { ok: true }
    },

    endReview(callerSessionID, targetSessionID) {
      const state = states.get(callerSessionID)
      // Ending a review is bound to the target the caller is actually reviewing:
      // a mismatched request must not discard another target's binding.
      if (state === undefined) return { ok: true }
      if (state.targetSessionID !== targetSessionID) {
        return { ok: false, reason: "queue: review target mismatch" }
      }
      detachAbort(state)
      states.delete(callerSessionID)
      return { ok: true }
    },

    discardCaller(callerSessionID) {
      // Caller-scoped lifecycle cleanup (session deletion): deliberately clears
      // whichever target is bound without requiring the target ID.
      const state = states.get(callerSessionID)
      if (state !== undefined) detachAbort(state)
      states.delete(callerSessionID)
    },

    has(callerSessionID) {
      return states.has(callerSessionID)
    },

    size() {
      return states.size
    },

    dispose() {
      for (const state of states.values()) detachAbort(state)
      states.clear()
    },
  }
}
