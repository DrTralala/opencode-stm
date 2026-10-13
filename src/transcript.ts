import { createHash, randomUUID } from "node:crypto"
import type { PageMessage } from "./sdk.js"
import { chunkText } from "./injection.js"

export const CHUNK_BYTES = 16 * 1024
export const CHUNK_LINES = 1999
export const PAGER_MAX_CALLERS = 16
// Constant, bounded refusal when the metadata/framing envelope cannot fit with
// any source progress. The message never echoes the oversized value.
export const ENVELOPE_BUDGET_REASON = "pager: output envelope cannot fit the continuation budget"

export type TextEntry = { messageID: string; role: "user" | "assistant"; partIndex: number; text: string }

export function extractVisibleText(items: PageMessage[]): TextEntry[] {
  const entries: TextEntry[] = []
  for (const item of items) {
    const role = item.info.role
    if (role !== "user" && role !== "assistant") continue
    // Ordinary user messages carry summary metadata (title/body/diffs): their
    // visible text is real history and must be retained. Only an assistant
    // message explicitly marked as a summary is synthetic output.
    if (role === "assistant" && item.info.summary === true) continue
    for (let partIndex = 0; partIndex < item.parts.length; partIndex += 1) {
      const part = item.parts[partIndex]
      if (part === undefined) continue
      if (part.type !== "text" || part.synthetic === true || part.ignored === true) continue
      if (typeof part.text !== "string" || part.text.length === 0) continue
      entries.push({ messageID: item.info.id, role, partIndex, text: part.text })
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
  // Source progress within the current page: the next entry to deliver and the
  // UTF-8 byte offset already delivered inside it. Progress is tracked on the
  // source, never on serialized JSON, so record framing can change per chunk.
  entryIndex: number
  entryOffset: number
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
// Role and original part index are part of the identity: a page whose speaker
// attribution or part numbering changed must fail closed like any text change.
function digestPage(page: SupplyPage): string {
  const hash = createHash("sha256")
  hash.update("stm-page-v2;")
  for (const entry of page.entries) {
    const idBytes = Buffer.from(entry.messageID, "utf8")
    const textBytes = Buffer.from(entry.text, "utf8")
    hash.update(`role:${entry.role.length}:`)
    hash.update(entry.role)
    hash.update(`;part:${entry.partIndex};id:${idBytes.byteLength}:`)
    hash.update(idBytes)
    hash.update(`;text:${textBytes.byteLength}:`)
    hash.update(textBytes)
    hash.update(";")
  }
  hash.update(`cursor:${JSON.stringify(page.nextCursor)}`)
  return hash.digest("hex")
}

// Largest code-point boundary at or below `offset`, so a cut never splits a
// multi-byte code point.
function snapDown(buffer: Buffer, offset: number): number {
  let end = Math.min(offset, buffer.byteLength)
  while (end > 0 && (buffer[end]! & 0b1100_0000) === 0b1000_0000) end -= 1
  return end
}

type RemainingPart = { entry: TextEntry; encoded: Buffer; start: number }

function remainingParts(entries: TextEntry[], entryIndex: number, entryOffset: number): RemainingPart[] {
  const parts: RemainingPart[] = []
  for (let index = entryIndex; index < entries.length; index += 1) {
    const entry = entries[index]!
    const encoded = Buffer.from(entry.text, "utf8")
    const start = index === entryIndex ? snapDown(encoded, entryOffset) : 0
    parts.push({ entry, encoded, start })
  }
  return parts
}

function remainingBytes(parts: RemainingPart[]): number {
  let total = 0
  for (const part of parts) total += part.encoded.byteLength - part.start
  return total
}

type EndPosition = { index: number; offset: number }

// The end position after `count` source bytes from the start of the remaining
// stream, snapped down to a code-point boundary inside its part.
function endpointAt(parts: RemainingPart[], count: number): EndPosition {
  let remaining = count
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!
    const length = part.encoded.byteLength - part.start
    if (remaining < length) return { index, offset: snapDown(part.encoded, part.start + remaining) }
    if (remaining === length) return { index, offset: part.encoded.byteLength }
    remaining -= length
  }
  const last = parts.length - 1
  if (last < 0) return { index: -1, offset: 0 }
  return { index: last, offset: parts[last]!.encoded.byteLength }
}

// Largest count of source bytes that still leaves the page strictly
// incomplete, so a partial result never claims the rest of the page and never
// causes an empty-success loop when the remainder cannot be rendered.
function strictPartialBytes(parts: RemainingPart[]): number {
  const total = remainingBytes(parts)
  if (total === 0) return 0
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!
    if (part.encoded.byteLength - part.start <= 0) continue
    const snapped = snapDown(part.encoded, part.encoded.byteLength - 1)
    return total - (part.encoded.byteLength - snapped)
  }
  return 0
}

// Bytes of the first complete code point available from the remaining stream:
// the smallest source count that still makes real progress. Zero when nothing
// remains. Counts below this snap back to the current position and would
// serialize no records, so a partial candidate must never be settled from them.
function firstCodePointBytes(parts: RemainingPart[]): number {
  for (const part of parts) {
    if (part.encoded.byteLength - part.start <= 0) continue
    let size = 1
    while (
      part.start + size < part.encoded.byteLength &&
      (part.encoded[part.start + size]! & 0b1100_0000) === 0b1000_0000
    ) {
      size += 1
    }
    return size
  }
  return 0
}

type RenderedPayload = { payload: string; messages: number; bytes: number }

// Serialize a complete JSON record for every source interval ending at
// (endIndex, endOffset). Returns null as soon as the serialized payload alone
// would exceed a whole output budget, so no unbounded page is serialized in
// full merely to discover that it cannot fit.
function renderPayload(parts: RemainingPart[], endIndex: number, endOffset: number): RenderedPayload | null {
  const lines: string[] = []
  let payloadBytes = 0
  let messages = 0
  let bytes = 0
  for (let index = 0; index < parts.length; index += 1) {
    if (index > endIndex) break
    const part = parts[index]!
    const end = index === endIndex ? endOffset : part.encoded.byteLength
    if (end <= part.start) continue
    const text = part.encoded.subarray(part.start, end).toString("utf8")
    const fragment = {
      role: part.entry.role,
      messageID: part.entry.messageID,
      partIndex: part.entry.partIndex,
      offsetBytes: part.start,
      partComplete: end === part.encoded.byteLength,
      text,
    }
    const line = JSON.stringify(fragment)
    payloadBytes += Buffer.byteLength(line, "utf8") + (lines.length === 0 ? 0 : 1)
    if (payloadBytes > CHUNK_BYTES) return null
    lines.push(line)
    if (end === part.encoded.byteLength) messages += 1
    bytes += end - part.start
  }
  return { payload: lines.join("\n"), messages, bytes }
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
  payload: string
}

// One JSON metadata header line, a blank line, then the framed JSONL payload.
// Metadata, separators, framing and record serialization all consume the
// budget: callers must measure this complete string, not a source slice.
function formatOutput(input: OutputInput): string {
  const header = JSON.stringify({
    plugin: "opencode-stm",
    status: "ok",
    sessionID: input.targetSessionID,
    format: "jsonl",
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
    payload: input.payload,
    complete: input.complete,
  })
  return `${header}\n\n${frame}`
}

function transcriptOutputFits(output: string): boolean {
  return Buffer.byteLength(output, "utf8") <= CHUNK_BYTES && output.split("\n").length <= CHUNK_LINES
}

type Candidate = { output: string; messages: number; bytes: number; endIndex: number; endOffset: number }

type CandidateInput = {
  parts: RemainingPart[]
  endIndex: number
  endOffset: number
  targetSessionID: string
  page: number
  cursorLabel: string | null
  cursor: string | null
  complete: boolean
}

function renderCandidate(input: CandidateInput): Candidate | null {
  const rendered = renderPayload(input.parts, input.endIndex, input.endOffset)
  if (rendered === null) return null
  const output = formatOutput({
    targetSessionID: input.targetSessionID,
    page: input.page,
    cursorLabel: input.cursorLabel,
    messages: rendered.messages,
    bytes: rendered.bytes,
    cursor: input.cursor,
    complete: input.complete,
    payload: rendered.payload,
  })
  return { output, messages: rendered.messages, bytes: rendered.bytes, endIndex: input.endIndex, endOffset: input.endOffset }
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
          entryIndex: 0,
          entryOffset: 0,
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
      if (
        pending === null &&
        (state.entryIndex > 0 || state.entryOffset > 0) &&
        state.pageDigest !== null &&
        digest !== state.pageDigest
      ) {
        // The page changed under the stored offsets (new messages, edited text,
        // changed speaker attribution or renumbered parts). Fail closed, drop
        // the binding and require an explicit restart with no cursor; never
        // guess, skip or mislabel content.
        detachAbort(state)
        states.delete(callerSessionID)
        return { ok: false, reason: "pager: page changed; restart the transcript review" }
      }

      // A pending page switch is owned by this fetch: render the new page from
      // its start while the committed metadata stays untouched.
      const effectivePage = pending === null ? state.page : pending.page
      const effectivePageCursor = pending === null ? state.pageCursor : pending.cursor
      const entryIndex = pending === null ? state.entryIndex : 0
      const entryOffset = pending === null ? state.entryOffset : 0
      const cursorLabel = effectivePageCursor ?? null
      const parts = remainingParts(page.entries, entryIndex, entryOffset)
      const remainingTotal = remainingBytes(parts)

      // Commit only after a candidate has been rendered and verified to fit; a
      // pending page switch commits here too, and offsets never advance on a
      // refusal (releaseFetch discards the pending switch).
      const settle = (candidate: Candidate, exhausted: boolean): SupplyResult => {
        if (state.pending !== null) {
          state.pageCursor = state.pending.cursor
          state.page = state.pending.page
          state.pending = null
        }
        if (exhausted) {
          state.entryIndex = 0
          state.entryOffset = 0
          state.complete = page.nextCursor === null
          state.issuedCursor = page.nextCursor
          state.pageDigest = null
        } else {
          state.entryIndex = entryIndex + candidate.endIndex
          state.entryOffset = candidate.endOffset
          state.complete = false
          state.issuedCursor = null
          state.pageDigest = digest
        }
        releaseFetch(state)
        return { ok: true, output: candidate.output }
      }

      // Candidate 1: finish the remaining page with its true completion/cursor
      // metadata. Serialized source bytes are at least the source bytes, so a
      // stream that already exceeds the whole byte cap is never serialized.
      if (remainingTotal <= CHUNK_BYTES) {
        const end = endpointAt(parts, remainingTotal)
        const candidate = renderCandidate({
          parts,
          endIndex: end.index,
          endOffset: end.offset,
          targetSessionID: state.targetSessionID,
          page: effectivePage,
          cursorLabel,
          cursor: page.nextCursor,
          complete: page.nextCursor === null,
        })
        if (candidate !== null && transcriptOutputFits(candidate.output)) return settle(candidate, true)
      }

      // Candidate 2: the largest code-point-aligned source prefix strictly
      // shorter than the remaining page, with partial metadata. Only counts
      // that deliver at least one whole code point are eligible: below
      // `minProgress` the endpoint snaps back to the current position, the
      // record set is empty, and settling it would repeat forever without
      // advancing. Over the eligible domain fitness is monotone: adding source
      // bytes never shrinks the rendered output.
      const strictLimit = strictPartialBytes(parts)
      const minProgress = firstCodePointBytes(parts)
      if (minProgress > 0 && strictLimit >= minProgress) {
        const fitsAt = (count: number): Candidate | null => {
          const end = endpointAt(parts, count)
          const candidate = renderCandidate({
            parts,
            endIndex: end.index,
            endOffset: end.offset,
            targetSessionID: state.targetSessionID,
            page: effectivePage,
            cursorLabel,
            cursor: null,
            complete: false,
          })
          if (candidate === null || candidate.bytes === 0 || !transcriptOutputFits(candidate.output)) return null
          return candidate
        }
        const largest = fitsAt(strictLimit)
        if (largest !== null) return settle(largest, false)
        // Presence sentinel: the search domain starts at the first
        // progress-bearing count. If even that cannot fit, refuse rather than
        // settle an empty partial.
        if (fitsAt(minProgress) !== null) {
          let lo = minProgress
          let hi = strictLimit
          while (lo < hi) {
            const mid = Math.floor((lo + hi + 1) / 2)
            if (fitsAt(mid) !== null) lo = mid
            else hi = mid - 1
          }
          const candidate = fitsAt(lo)
          if (candidate !== null) return settle(candidate, false)
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
