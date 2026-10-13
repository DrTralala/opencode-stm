import { createHash, randomUUID } from "node:crypto"
import type { PageMessage } from "./sdk.js"
import { chunkText } from "./injection.js"

export const CHUNK_BYTES = 16 * 1024
export const CHUNK_LINES = 1999
export const PAGER_MAX_CALLERS = 16
// Constant, bounded refusal when the metadata/framing envelope cannot fit with
// any source progress. The message never echoes the oversized value.
export const ENVELOPE_BUDGET_REASON = "pager: output envelope cannot fit the continuation budget"

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

export type BeginInput = {
  callerSessionID: string
  targetSessionID: string
  cursor?: string
  signal?: AbortSignal
}

export type BeginResult =
  | { ok: true; token: string; fetchCursor: string | undefined }
  | { ok: false; reason: string }

export type SupplyPage = { entries: TextEntry[]; nextCursor: string | null }

export type SupplyResult = { ok: true; output: string } | { ok: false; reason: string }

export type EndReviewResult = { ok: true } | { ok: false; reason: string }

export interface TranscriptPager {
  begin(input: BeginInput): BeginResult
  supply(callerSessionID: string, page: SupplyPage, token: string): SupplyResult
  release(callerSessionID: string, token: string): boolean
  endReview(callerSessionID: string, targetSessionID: string): EndReviewResult
  discardCaller(callerSessionID: string): void
  has(callerSessionID: string): boolean
  size(): number
  dispose(): void
}

// A page switch requested by an exhausted page's issued cursor. It is only
// committed when a supply succeeds, so a failed read or an envelope refusal
// rolls back to the page and cursor issued by the last successful result.
type PendingAdvance = { cursor: string; page: number }

type CallerState = {
  targetSessionID: string
  // Opaque generation token for the fetch currently owning this binding. Every
  // begin rotates it; supply and release must present it.
  requestToken: string
  // True while a fetch owns the binding. A second begin must not race offsets.
  active: boolean
  // Committed cursor that produced the current page; undefined is the newest page.
  pageCursor: string | undefined
  // Bytes of the current page's newline-joined entry stream already delivered.
  // A single code-point-aligned offset is enough because the page is refetched
  // whole on every continuation.
  pageOffset: number
  complete: boolean
  // Cursor issued with the last exhausted page, or null while a page is partial.
  issuedCursor: string | null
  page: number
  // Page fingerprint retained only while a page is partially consumed, so a
  // mutated page fails closed instead of silently skipping content.
  pageDigest: string | null
  // Page switch owned by the active fetch, or null. Never committed until the
  // fetch supplies successfully.
  pending: PendingAdvance | null
  signal?: AbortSignal
  abortListener?: () => void
}

// Tagged and length-prefixed so no cursor value (including the literal "end")
// can collide with the null cursor marker, and adjacent fields cannot alias.
function digestPage(page: SupplyPage): string {
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

// The page source stream is the visible entries joined by a single newline.
// Offsets always land on code-point boundaries and separators are part of the
// stream, so concatenating delivered slices reproduces it byte-for-byte.
type PageStream = { joined: Buffer; starts: number[]; lengths: number[] }

function buildPageStream(entries: TextEntry[]): PageStream {
  const buffers = entries.map((entry) => Buffer.from(entry.text, "utf8"))
  const lengths = buffers.map((buffer) => buffer.byteLength)
  const starts: number[] = []
  let total = 0
  for (let index = 0; index < buffers.length; index += 1) {
    starts.push(total)
    total += lengths[index]!
    if (index + 1 < buffers.length) total += 1
  }
  const joined = Buffer.allocUnsafe(total)
  let at = 0
  for (let index = 0; index < buffers.length; index += 1) {
    buffers[index]!.copy(joined, at)
    at += lengths[index]!
    if (index + 1 < buffers.length) {
      joined[at] = 0x0a
      at += 1
    }
  }
  return { joined, starts, lengths }
}

// Entries completed by this result: the chunk that contains an entry's final
// byte counts it, so every entry is counted exactly once across a partition of
// the page stream. An entry ending exactly at the boundary belongs to the
// earlier chunk.
function countCompletedEntries(stream: PageStream, start: number, end: number): number {
  let count = 0
  for (let index = 0; index < stream.starts.length; index += 1) {
    const entryEnd = stream.starts[index]! + stream.lengths[index]!
    if (entryEnd > start && entryEnd <= end) count += 1
  }
  return count
}

function countNewlines(buffer: Buffer): number {
  let count = 0
  for (const byte of buffer) {
    if (byte === 0x0a) count += 1
  }
  return count
}

// Largest code-point boundary at or below `offset`, so a cut never splits a
// multi-byte code point.
function snapDown(buffer: Buffer, offset: number): number {
  let end = Math.min(offset, buffer.byteLength)
  while (end > 0 && (buffer[end]! & 0b1100_0000) === 0b1000_0000) end -= 1
  return end
}

function continuationGuidance(cursor: string | null, complete: boolean): string {
  if (complete) return "End of history for this target: stop calling stm_history_transcript."
  if (cursor !== null) return "More history remains: call stm_history_transcript again with this cursor."
  return "More of this page remains: call stm_history_transcript again without a cursor."
}

type OutputInput = {
  targetSessionID: string
  page: number
  cursorLabel: string | null
  messages: number
  bytes: number
  cursor: string | null
  complete: boolean
  text: string
}

// One JSON metadata header line, a blank line, then the framed untrusted text.
// Metadata, separators, framing and marker escaping all consume the budget.
function formatOutput(input: OutputInput): string {
  const header = JSON.stringify({
    plugin: "opencode-stm",
    status: "ok",
    sessionID: input.targetSessionID,
    page: input.page,
    messages: input.messages,
    bytes: input.bytes,
    cursor: input.cursor,
    more: !input.complete,
    complete: input.complete,
    continuation: continuationGuidance(input.cursor, input.complete),
  })
  const frame = chunkText({
    targetSessionID: input.targetSessionID,
    cursorLabel: input.cursorLabel,
    page: input.page,
    text: input.text,
    complete: input.complete,
  })
  return `${header}\n\n${frame}`
}

function transcriptOutputFits(output: string): boolean {
  return Buffer.byteLength(output, "utf8") <= CHUNK_BYTES && output.split("\n").length <= CHUNK_LINES
}

export function createTranscriptPager(options: { maxCallers?: number } = {}): TranscriptPager {
  // A caller-tunable capacity may only lower the hard cap: valid positive integers
  // above PAGER_MAX_CALLERS are clamped, any other value fails closed with a
  // deterministic error instead of silently disabling the cap.
  const requested = options.maxCallers
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
    throw new RangeError("maxCallers must be a positive integer")
  }
  const maxCallers = requested === undefined ? PAGER_MAX_CALLERS : Math.min(requested, PAGER_MAX_CALLERS)
  const states = new Map<string, CallerState>()

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
        detachAbort(live)
        // An in-flight abort invalidates the binding: offsets from a fetch that
        // was cancelled are never trusted, so the next review restarts.
        states.delete(callerSessionID)
      }
    }
    state.signal = signal
    state.abortListener = listener
    signal.addEventListener("abort", listener, { once: true })
  }

  // End the fetch attempt, release its listener and make its token stale. An
  // uncommitted page switch is discarded: the issued cursor and committed page
  // remain retryable exactly as the last successful result left them.
  function releaseFetch(state: CallerState): void {
    detachAbort(state)
    state.active = false
    state.pending = null
    state.requestToken = randomUUID()
  }

  return {
    begin(input) {
      if (input.signal !== undefined && input.signal.aborted) {
        return { ok: false, reason: "pager: aborted" }
      }
      const state = states.get(input.callerSessionID)
      if (state === undefined) {
        if (input.cursor !== undefined) return { ok: false, reason: "pager: unknown cursor" }
        if (states.size >= maxCallers) return { ok: false, reason: "pager: too many callers" }
        const created: CallerState = {
          targetSessionID: input.targetSessionID,
          requestToken: randomUUID(),
          active: true,
          pageCursor: undefined,
          pageOffset: 0,
          complete: false,
          issuedCursor: null,
          page: 1,
          pageDigest: null,
          pending: null,
        }
        states.set(input.callerSessionID, created)
        setRequestSignal(input.callerSessionID, created, input.signal)
        return { ok: true, token: created.requestToken, fetchCursor: undefined }
      }
      if (state.targetSessionID !== input.targetSessionID) {
        return { ok: false, reason: "pager: target binding mismatch; end review first" }
      }
      if (state.active) return { ok: false, reason: "pager: fetch in progress" }
      if (state.complete) return { ok: false, reason: "pager: end of history" }
      const normalized = input.cursor ?? null
      if (normalized !== state.issuedCursor) {
        return { ok: false, reason: "pager: cursor not issued to this caller/target" }
      }
      let fetchCursor = state.pageCursor
      if (input.cursor !== undefined) {
        // The exhausted page issued this cursor: select the next page but do
        // not consume the cursor or advance the committed page yet. A failed
        // read or a refusal must leave the same cursor retryable; only a
        // successful supply commits the switch.
        state.pending = { cursor: input.cursor, page: state.page + 1 }
        fetchCursor = input.cursor
      }
      setRequestSignal(input.callerSessionID, state, input.signal)
      state.requestToken = randomUUID()
      state.active = true
      return { ok: true, token: state.requestToken, fetchCursor }
    },

    supply(callerSessionID, page, token) {
      const state = states.get(callerSessionID)
      if (state === undefined) return { ok: false, reason: "pager: not started" }
      if (token !== state.requestToken || !state.active) {
        // A response from a superseded, released, ended or aborted fetch must
        // never enter the current binding.
        return { ok: false, reason: "pager: stale request" }
      }
      if (state.signal !== undefined && state.signal.aborted) {
        // Defensive: the listener normally removes the state synchronously.
        detachAbort(state)
        states.delete(callerSessionID)
        return { ok: false, reason: "pager: aborted" }
      }

      const digest = digestPage(page)
      const pending = state.pending
      if (pending === null && state.pageOffset > 0 && state.pageDigest !== null && digest !== state.pageDigest) {
        // The page changed under the stored offsets (new messages or edited
        // text). Fail closed, drop the binding and require an explicit restart
        // with no cursor; never guess, skip or mislabel content.
        detachAbort(state)
        states.delete(callerSessionID)
        return { ok: false, reason: "pager: page changed; restart the transcript review" }
      }

      const stream = buildPageStream(page.entries)
      const pageLength = stream.joined.byteLength
      // A pending page switch is owned by this fetch: render the new page from
      // its start while the committed metadata stays untouched.
      const effectivePage = pending === null ? state.page : pending.page
      const effectivePageCursor = pending === null ? state.pageCursor : pending.cursor
      const start = pending === null ? Math.min(state.pageOffset, pageLength) : 0
      const remainingLength = pageLength - start
      const cursorLabel = effectivePageCursor ?? null

      const renderPartial = (endOffset: number): string =>
        formatOutput({
          targetSessionID: state.targetSessionID,
          page: effectivePage,
          cursorLabel,
          messages: countCompletedEntries(stream, start, endOffset),
          bytes: endOffset - start,
          cursor: null,
          complete: false,
          text: stream.joined.subarray(start, endOffset).toString("utf8"),
        })

      // Commit only after a candidate has been rendered and verified to fit; a
      // pending page switch commits here too, and offsets never advance on a
      // refusal (releaseFetch discards the pending switch).
      const settle = (output: string, endOffset: number, exhausted: boolean): SupplyResult => {
        if (state.pending !== null) {
          state.pageCursor = state.pending.cursor
          state.page = state.pending.page
          state.pageOffset = 0
          state.pending = null
        }
        if (exhausted) {
          state.pageOffset = 0
          state.complete = page.nextCursor === null
          state.issuedCursor = page.nextCursor
          state.pageDigest = null
        } else {
          state.pageOffset = endOffset
          state.complete = false
          state.issuedCursor = null
          state.pageDigest = digest
        }
        releaseFetch(state)
        return { ok: true, output }
      }

      // Candidate 1: finish the remaining page with its true completion/cursor
      // metadata. The pre-checks bound the render: source bytes and newlines are
      // lower bounds of the final output, so over-budget pages are never
      // rendered in full.
      if (remainingLength <= CHUNK_BYTES && countNewlines(stream.joined.subarray(start)) <= CHUNK_LINES) {
        const output = formatOutput({
          targetSessionID: state.targetSessionID,
          page: effectivePage,
          cursorLabel,
          messages: countCompletedEntries(stream, start, pageLength),
          bytes: remainingLength,
          cursor: page.nextCursor,
          complete: page.nextCursor === null,
          text: stream.joined.subarray(start, pageLength).toString("utf8"),
        })
        if (transcriptOutputFits(output)) return settle(output, pageLength, true)
      }

      // Candidate 2: the largest code-point-aligned prefix with partial
      // metadata, strictly shorter than the remaining page so the "more of this
      // page remains" guidance stays accurate. Binary search is monotone: the
      // rendered output only grows as the prefix grows.
      if (remainingLength > 0) {
        const pageEndBoundary = snapDown(stream.joined, pageLength - 1)
        const high = Math.min(start + CHUNK_BYTES, pageEndBoundary) - start
        if (high > 0) {
          const endFor = (count: number): number => snapDown(stream.joined, start + count)
          const fitsAt = (count: number): boolean => transcriptOutputFits(renderPartial(endFor(count)))
          if (fitsAt(0)) {
            let lo = 0
            let hi = high
            if (fitsAt(hi)) {
              lo = hi
            } else {
              while (lo < hi) {
                const mid = Math.floor((lo + hi + 1) / 2)
                if (fitsAt(mid)) lo = mid
                else hi = mid - 1
              }
            }
            const end = endFor(lo)
            if (end > start) return settle(renderPartial(end), end, false)
          }
        }
      }

      // The envelope cannot fit with any source progress: return a constant
      // bounded refusal without advancing offsets. The fetch is released so a
      // later begin can retry the same page.
      releaseFetch(state)
      return { ok: false, reason: ENVELOPE_BUDGET_REASON }
    },

    release(callerSessionID, token) {
      const state = states.get(callerSessionID)
      if (state === undefined || token !== state.requestToken || !state.active) return false
      // Offsets are deliberately untouched: a failed page read is retryable
      // with a fresh begin, and a successful commit already rotated the token.
      releaseFetch(state)
      return true
    },

    endReview(callerSessionID, targetSessionID) {
      const state = states.get(callerSessionID)
      // Ending a review is bound to the target the caller is actually reviewing:
      // a mismatched request must not discard another target's binding.
      if (state === undefined) return { ok: true }
      if (state.targetSessionID !== targetSessionID) {
        return { ok: false, reason: "pager: review target mismatch" }
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
