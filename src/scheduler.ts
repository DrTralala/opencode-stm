import { ANCHOR_MAX, FRONTIER_MAX, initialMeta, type AnchorState, type SessionMeta } from "./state.js"
import type { ReviewConfig } from "./config.js"
import type { MutableMessage, MutablePart } from "./injection.js"

export const STM_TOOL_NAMES: readonly string[] = [
  "stm_title_read",
  "stm_title_review",
  "stm_title_lock",
  "stm_history_title_read",
  "stm_history_title_rename",
  "stm_history_transcript",
  "stm_history_review_end",
]

export type ObservedMessage = { id: string; eligible: boolean; summary: boolean }

function hasSummary(value: MutableMessage["info"]["summary"]): boolean {
  return value === true || (typeof value === "object" && value !== null)
}

function hasRealText(part: MutablePart): boolean {
  return (
    part.type === "text" &&
    part.synthetic !== true &&
    part.ignored !== true &&
    typeof part.text === "string" &&
    part.text.trim().length > 0
  )
}

function isEligibleMessage(message: MutableMessage): boolean {
  if (hasSummary(message.info.summary)) return false
  if (message.info.role === "user") {
    return message.parts.some((part) => hasRealText(part) || part.type === "file" || part.type === "subtask")
  }
  if (message.info.role !== "assistant") return false
  return message.parts.some((part) => {
    if (hasRealText(part)) return true
    if (part.type === "tool") return typeof part.tool === "string" && !STM_TOOL_NAMES.includes(part.tool)
    return part.type === "file"
  })
}

export function classifyMessages(messages: MutableMessage[]): ObservedMessage[] {
  const observed: ObservedMessage[] = []
  for (const message of messages) {
    const id = message.info.id
    if (typeof id !== "string" || id.length === 0) continue
    observed.push({ id, eligible: isEligibleMessage(message), summary: hasSummary(message.info.summary) })
  }
  return observed
}

const DEFAULT_TITLE_PATTERN = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isDefaultTitle(title: string): boolean {
  return DEFAULT_TITLE_PATTERN.test(title)
}

export function anchorPartID(reviewID: string, reminderIndex: number): string {
  return `stm-reminder-${reviewID}-${reminderIndex}`
}

export type ObserveDeps = { newId: () => string }
export type ObserveResult = { meta: SessionMeta; anchor: AnchorState | null }

function capFrontier(ids: string[]): string[] {
  return ids.length <= FRONTIER_MAX ? ids : ids.slice(-FRONTIER_MAX)
}

function capAnchors(anchors: AnchorState[]): AnchorState[] {
  return anchors.length <= ANCHOR_MAX ? anchors : anchors.slice(-ANCHOR_MAX)
}

function lastEligibleID(observed: ObservedMessage[]): string | null {
  for (const message of [...observed].reverse()) {
    if (message.eligible) return message.id
  }
  return null
}

export function observe(
  meta: SessionMeta,
  observed: ObservedMessage[],
  config: ReviewConfig,
  deps: ObserveDeps,
): ObserveResult {
  const next: SessionMeta = {
    ...meta,
    frontier: [...meta.frontier],
    anchors: meta.anchors.map((anchor) => ({ ...anchor })),
  }

  // Mark missing anchors obsolete before any early return, including the
  // rebaseline branch below: compaction is exactly when anchors vanish.
  for (const anchor of next.anchors) {
    if (!anchor.obsolete && !observed.some((m) => m.id === anchor.anchorMessageID)) {
      anchor.obsolete = true
    }
  }

  const baselineIndex =
    next.baselineMessageID === null ? -1 : observed.findIndex((m) => m.id === next.baselineMessageID)
  const baselineGone = next.baselineMessageID !== null && baselineIndex === -1
  const unseenSummary =
    baselineIndex >= 0 &&
    observed.some((m, index) => index > baselineIndex && m.summary && !next.frontier.includes(m.id))
  if (next.baselineMessageID === null || baselineGone || unseenSummary) {
    next.frontier = capFrontier(observed.map((m) => m.id))
    next.baselineMessageID = observed.at(-1)?.id ?? next.baselineMessageID
    return { meta: next, anchor: null }
  }

  // Count only messages beyond the known baseline position. Older IDs that have
  // aged out of the capped frontier are never recounted on a replay.
  for (let index = baselineIndex + 1; index < observed.length; index += 1) {
    const message = observed[index]!
    if (!next.frontier.includes(message.id)) {
      next.frontier.push(message.id)
      if (message.eligible) next.activity += 1
    }
  }
  next.frontier = capFrontier(next.frontier)
  next.baselineMessageID = observed.at(-1)?.id ?? next.baselineMessageID

  if (next.locked || !config.enabled) return { meta: next, anchor: null }

  if (next.review === null && next.activity >= config.intervalMessages) {
    const anchorMessageID = lastEligibleID(observed)
    if (anchorMessageID === null) return { meta: next, anchor: null }
    const review = {
      id: deps.newId(),
      remindersSent: 1,
      // Cumulative threshold from the review baseline, not from a jumped
      // current activity: interval + interval * multiplier = 60 by default.
      nextTriggerAt: config.intervalMessages + config.intervalMessages * config.backoffMultiplier,
    }
    const anchor: AnchorState = {
      reviewID: review.id,
      reminderIndex: 0,
      anchorMessageID,
      partID: anchorPartID(review.id, 0),
      obsolete: false,
    }
    next.review = review
    next.anchors = capAnchors([...next.anchors, anchor])
    return { meta: next, anchor }
  }

  if (
    next.review !== null &&
    next.review.remindersSent < config.maxReminders &&
    next.activity >= next.review.nextTriggerAt
  ) {
    const anchorMessageID = lastEligibleID(observed)
    if (anchorMessageID === null) return { meta: next, anchor: null }
    const index = next.review.remindersSent
    const anchor: AnchorState = {
      reviewID: next.review.id,
      reminderIndex: index,
      anchorMessageID,
      partID: anchorPartID(next.review.id, index),
      obsolete: false,
    }
    next.review = {
      ...next.review,
      remindersSent: index + 1,
      // Advance from the previous cumulative threshold, so a jump past several
      // thresholds emits at most one reminder per observation and preserves the
      // schedule (60, 140, 300 by default).
      nextTriggerAt: next.review.nextTriggerAt + config.intervalMessages * Math.pow(config.backoffMultiplier, index + 1),
    }
    next.anchors = capAnchors([...next.anchors, anchor])
    return { meta: next, anchor }
  }

  return { meta: next, anchor: null }
}

export function firstObservation(isDefault: boolean, digest: string): SessionMeta {
  const meta = initialMeta()
  if (isDefault) return { ...meta, titleDigest: digest }
  return { ...meta, locked: true, lockReason: "non-default-title" }
}

export function lockManually(meta: SessionMeta): SessionMeta {
  return { ...meta, locked: true, lockReason: "manual" }
}

export function lockExternal(meta: SessionMeta): SessionMeta {
  return { ...meta, locked: true, lockReason: "external" }
}

export function unlock(meta: SessionMeta, digest: string): SessionMeta {
  // Discard any pending review so the next scheduled review is created with a
  // fresh identifier; reset the activity baseline; keep existing anchors as
  // historical context so retained reminders are neither re-anchored nor moved.
  return {
    ...meta,
    activity: 0,
    locked: false,
    lockReason: "none",
    titleDigest: digest,
    review: null,
  }
}

export function resolveReview(meta: SessionMeta, digest: string): SessionMeta {
  // Retain resolved anchors unchanged: resolved reminders stay in place as
  // historical context and age out through obsolete marking and the cap.
  return { ...meta, activity: 0, review: null, titleDigest: digest }
}
