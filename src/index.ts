// Plugin wiring: transform pipeline, event lifecycle and exported module.
// The transform mutates the existing outgoing array in place, persists atomic
// latest-state transitions and never replaces output.messages.

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import type { Hooks, Plugin, PluginInput, PluginModule, ToolDefinition } from "@opencode-ai/plugin"
import { loadConfig } from "./config.js"
import { ensureAnchorPart, singleSessionMessages, type MutableMessage } from "./injection.js"
import {
  anchorPartID,
  classifyMessages,
  firstObservation,
  isDefaultTitle,
  lockExternal,
  observe,
  type ObserveResult,
} from "./scheduler.js"
import { createRootCache, readSession } from "./sdk.js"
import { createOperationGuard, createStateStore, hashTitle, resolveStateDir, type SessionMeta } from "./state.js"
import { createTranscriptPager } from "./transcript.js"
import { createCurrentTools, createHistoricalTools, type StmServices } from "./tools.js"

export const STM_PLUGIN_ID = "opencode-stm"

export type StmRuntime = { env?: NodeJS.ProcessEnv; home?: string; now?: () => number }

type InjectionPlan = { anchors: SessionMeta["anchors"]; locked: boolean } | null

// Drop an anchor the observation just created (and any review created with it):
// it was never verified against the live title, so a later observation must
// re-create it only after the check passes. Activity advancement is kept.
function stripUnverifiedAnchor(candidate: SessionMeta, base: SessionMeta): SessionMeta {
  if (base.review === null && candidate.review !== null) {
    const partID = anchorPartID(candidate.review.id, 0)
    return { ...candidate, review: null, anchors: candidate.anchors.filter((anchor) => anchor.partID !== partID) }
  }
  if (base.review !== null && candidate.review !== null && candidate.review.remindersSent > base.review.remindersSent) {
    const partID = anchorPartID(candidate.review.id, base.review.remindersSent)
    return { ...candidate, review: base.review, anchors: candidate.anchors.filter((anchor) => anchor.partID !== partID) }
  }
  return candidate
}

export function createTransform(
  services: StmServices,
): NonNullable<Hooks["experimental.chat.messages.transform"]> {
  return async (_input, output) => {
    const single = singleSessionMessages(output as unknown as { messages: MutableMessage[] })
    if (!single.ok) return
    const sessionID = single.sessionID

    // Child sessions never receive periodic reviews.
    const root = await services.roots.isRoot(sessionID)
    if (!root.ok || !root.value) return

    // Transcript retrieval returns its bounded result directly from the tool
    // call; the transform only owns title-review reminder injection.

    const loaded = await services.state.load(sessionID)
    if (!loaded.ok) return
    let fallback = loaded.value
    if (fallback === null) {
      const read = await readSession(services.client, sessionID)
      if (!read.ok) return
      fallback = firstObservation(isDefaultTitle(read.value.title), hashTitle(read.value.title))
    }

    const observed = classifyMessages(single.messages)
    const run = (base: SessionMeta): ObserveResult =>
      observe(base, observed, services.config.review, { newId: () => randomUUID() })

    // Probe with the best-known metadata to decide whether a live title check is
    // needed: before creating a new anchor and, per the approved policy, before
    // replaying the anchors of an unresolved review on every normal request.
    // Retained anchors of resolved reviews need no re-read.
    const probed = run(fallback)
    const needsTitleCheck = probed.anchor !== null || fallback.review !== null

    if (!needsTitleCheck) {
      // Persist atomically against the latest persisted metadata. The transition
      // is re-run on the freshest state so a concurrent lock, resolution or
      // baseline is preserved instead of overwritten by a stale snapshot.
      const saved = await services.state.update(sessionID, (current) => {
        const base = current ?? fallback
        const candidate = run(base).meta
        // A concurrent transition may have moved a threshold within reach after
        // this transform probed. A reminder created here was never title-checked,
        // so drop it and let the next observation create it after re-reading the
        // live title; the activity advancement is kept.
        const next = stripUnverifiedAnchor(candidate, base)
        // If a concurrent transition introduced an unresolved review, replaying
        // its anchors here would skip the mandated title check; defer injection
        // to the next request, which takes the checked path.
        if (base.review !== null) return { next, result: null }
        return { next, result: { anchors: next.anchors, locked: next.locked } }
      })
      if (!saved.ok) return
      if (saved.value === null || saved.value.locked) return
      for (const anchor of saved.value.anchors) {
        if (!anchor.obsolete) ensureAnchorPart(single.messages, anchor)
      }
      return
    }

    // Serialise the live title check and the transition with the tools' guarded
    // sections (rename, lock, historical rename) so an attributed title change
    // that lands while this request is assembled is observed coherently: the
    // latest persisted state is never overwritten with a stale snapshot. The
    // guard is never nested here.
    const outcome = await services.guard.run(
      sessionID,
      async (): Promise<{ ok: true; plan: InjectionPlan } | { ok: false; reason: "title-read" | "state" }> => {
        const check = await readSession(services.client, sessionID)
        // Fail closed: without a verified title neither a new anchor nor an
        // unresolved reminder is replayed on this request.
        if (!check.ok) return { ok: false, reason: "title-read" }
        const saved = await services.state.update(sessionID, (current) => {
          const base = current ?? fallback
          // A lock that landed since the probe must win; nothing is injected.
          if (base.locked) return { next: base, result: null }
          // Re-validate against the latest persisted digest so a concurrent
          // unlock, keep or rename that already attributed the title is
          // respected here.
          const changed = base.titleDigest === null || hashTitle(check.value.title) !== base.titleDigest
          const candidate = run(base).meta
          if (changed) {
            // Unattributed change: lock the latest state conservatively, drop
            // any anchor this observation would have created and replay
            // nothing. The fresh base is locked; a stale snapshot is never
            // written back over a concurrent resolution.
            return { next: lockExternal(stripUnverifiedAnchor(candidate, base)), result: null }
          }
          return { next: candidate, result: { anchors: candidate.anchors, locked: candidate.locked } }
        })
        if (!saved.ok) return { ok: false, reason: "state" }
        return { ok: true, plan: saved.value }
      },
    )
    if (!outcome.ok) return
    if (outcome.plan === null || outcome.plan.locked) return
    for (const anchor of outcome.plan.anchors) {
      if (!anchor.obsolete) ensureAnchorPart(single.messages, anchor)
    }
  }
}

export function createEventHook(services: StmServices): NonNullable<Hooks["event"]> {
  return async (input) => {
    // Published 1.18.35 event types: only "session.deleted" is consumed; its
    // properties.info is a Session. Runtime payloads are still checked before
    // any cleanup runs.
    const event = input.event
    if (event.type !== "session.deleted") return
    const id = (event.properties.info as { id?: unknown } | undefined)?.id
    if (typeof id !== "string" || id.length === 0) return
    await services.state.removeOwned(id)
    services.roots.invalidate(id)
    services.transcripts.discardCaller(id)
    services.blocked.delete(id)
    for (const [caller, targets] of services.blocked) {
      if (targets.delete(id) && targets.size === 0) services.blocked.delete(caller)
    }
  }
}

export async function createStm(input: PluginInput, runtime: StmRuntime = {}): Promise<Hooks> {
  const env = runtime.env ?? process.env
  const home = runtime.home ?? homedir()
  const now = runtime.now ?? Date.now
  // Configuration is read once at startup; a missing file is created from the
  // packaged template first. An invalid or unreadable file, including a failed
  // creation, disables every hook and tool with a setting-scoped diagnostic
  // that never echoes the offending raw value.
  const loaded = loadConfig(env, home)
  if (!loaded.ok) {
    console.error(`[${STM_PLUGIN_ID}] disabled: ${loaded.reason}`)
    return { tool: {} }
  }
  const services: StmServices = {
    client: input.client,
    config: loaded.config,
    state: createStateStore({ stateDir: resolveStateDir(env, home), now }),
    transcripts: createTranscriptPager(),
    roots: createRootCache(input.client),
    guard: createOperationGuard(),
    blocked: new Map(),
    now,
  }
  // Tool definitions are fixed for the instance lifetime; config changes need a
  // restart.
  const tools: Record<string, ToolDefinition> = {
    ...createCurrentTools(services),
    ...createHistoricalTools(services),
  }
  return {
    tool: tools,
    "experimental.chat.messages.transform": createTransform(services),
    event: createEventHook(services),
    dispose: async () => {
      services.transcripts.dispose()
      services.roots.clear()
    },
  }
}

export const server: Plugin = (input) => createStm(input, {})

const pluginModule: PluginModule = { id: STM_PLUGIN_ID, server }

export default pluginModule
