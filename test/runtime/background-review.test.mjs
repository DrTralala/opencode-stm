// Task-8 compiled-plugin runtime scenarios. The host is a real `opencode serve`
// process with isolated HOME/XDG/TMPDIR and a loopback OpenAI-compatible
// provider. Only the built dist/src/index.js plugin is loaded; every dispatch is
// driven by a synthetic provider tool call, never by invoking the coordinator
// directly.

import assert from "node:assert/strict"
import test from "node:test"
import { REVIEWER_ONLY_SENTINEL, withLoopbackHost } from "./opencode-loopback.mjs"

function sessionText(items) {
  return items
    .flatMap((item) => item.parts ?? [])
    .filter((part) => part?.type === "text" || part?.type === "reasoning")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("compiled plugin dispatches asynchronously, keeps the parent moving and applies one rename", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const held = host.holdReviewer()
      const receipts = await host.dispatchViaMain()
      const reviewerRequest = await held

      assert.equal(receipts.dispatchStatus.plugin, "opencode-stm")
      assert.equal(receipts.dispatchStatus.status, "queued")
      assert.equal(reviewerRequest.kind, "review-child")
      assert.equal(reviewerRequest.model, "mock")
      assert.deepEqual(reviewerRequest.toolNames, [])
      assert.equal(reviewerRequest.toolChoice, null)
      assert.equal(reviewerRequest.systemMentionsStructuredOutput, false)
      assert.equal(reviewerRequest.promptHasToolCallRecords, false)
      assert.equal(reviewerRequest.promptHasToolResultRecords, false)
      assert.equal(reviewerRequest.promptContainsContinueMarker, false)
      assert.equal(reviewerRequest.promptContainsSeedMarker, true)

      const activeState = await host.waitForState(
        receipts.parentID,
        (state) =>
          typeof state.backgroundReview?.childSessionID === "string" &&
          typeof state.backgroundReview?.promptMessageID === "string",
      )
      receipts.stateAtDispatch = activeState
      receipts.childID = activeState.backgroundReview.childSessionID
      receipts.promptMessageID = activeState.backgroundReview.promptMessageID

      // The cutoff is the actual in-flight assistant message that issued the
      // provider-driven dispatch tool call, not a synthetic value.
      assert.equal(typeof receipts.dispatchAssistantMessageID, "string")
      assert.equal(receipts.cutoffMessageID, receipts.dispatchAssistantMessageID)
      assert.equal(typeof receipts.childID, "string")
      assert.equal(typeof receipts.promptMessageID, "string")
      assert.equal(receipts.stateAtDispatch.backgroundReview?.phase, "active")
      assert.equal(receipts.stateAtDispatch.backgroundReview?.reviewID !== null, true)

      const childSession = await host.client.session.get({
        path: { id: receipts.childID },
        query: { directory: host.directory },
      })
      assert.equal(childSession.error, undefined)
      assert.equal(childSession.data?.agent, "stm-probe-reviewer")
      assert.deepEqual(childSession.data?.permission, [
        { permission: "*", pattern: "*", action: "deny" },
      ])
      assert.deepEqual(childSession.data?.model, {
        id: "mock",
        providerID: "probe",
        variant: "high",
      })

      await host.continueParent("PARENT_CONTINUES_WHILE_REVIEW_PENDING")
      assert.equal(host.receipts.parentContinuedBeforeReviewerRelease, true)
      assert.equal(host.receipts.parentContinue.childHeldAtRequest, true)
      assert.equal(host.receipts.parentContinue.containsReviewReminder, false)
      assert.equal(host.receipts.parentContinue.assistantError, null)

      const parentBeforeRelease = await host.readParentMessages()
      const parentIDsBeforeRelease = parentBeforeRelease.map((item) => item.info.id)
      const requestIDsBeforeRelease = host.requests.map((request) => request.id)

      host.releaseReviewer({ decision: "rename", title: "Background reviewed title" })
      const resolved = await host.waitForReviewerResolution("Background reviewed title")
      assert.equal(resolved.title, "Background reviewed title")

      const parentAfter = await host.readParentMessages()
      assert.deepEqual(parentAfter.map((item) => item.info.id), parentIDsBeforeRelease)
      const parentText = sessionText(parentAfter)
      const requestsAfterRelease = host.requests.filter(
        (request) => !requestIDsBeforeRelease.includes(request.id),
      )
      host.receipts.parentContainsReviewFrame = parentText.includes(
        "BEGIN OPENCODE-STM REVIEW TRANSCRIPT",
      )
      host.receipts.parentContainsReviewerOnlySentinel =
        parentText.includes(REVIEWER_ONLY_SENTINEL)
      host.receipts.parentAutoWakeAfterReviewer =
        parentAfter.length !== parentIDsBeforeRelease.length ||
        requestsAfterRelease.some(
          (request) =>
            request.kind === "background-continue" || request.kind === "background-dispatch",
        )
      assert.equal(host.receipts.parentContainsReviewFrame, false)
      assert.equal(host.receipts.parentContainsReviewerOnlySentinel, false)
      assert.equal(parentText.includes("PARENT_CONTINUES_WHILE_REVIEW_PENDING"), true)
      assert.equal(host.receipts.parentAutoWakeAfterReviewer, false)
      assert.equal(parentAfter.length, parentIDsBeforeRelease.length)

      const childItems = await host.fullMessages(receipts.childID)
      const childText = sessionText(childItems)
      assert.equal(childText.includes(REVIEWER_ONLY_SENTINEL), true, "mock reviewer sentinel remained child-only")
      assert.equal(childText.includes('"decision":"rename"'), true)
      assert.equal(JSON.stringify(childItems).includes("Background reviewed title"), true)
      const childAssistant = childItems.find(
        (item) =>
          item?.info?.role === "assistant" &&
          typeof item.info.time?.completed === "number",
      )
      assert.equal(childAssistant?.info?.variant, "high")
    },
    { compiledPlugin: true, reviewerVariant: "high" },
  )
})

test("compiled plugin denies start, task and review permission before any child is created", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      for (const permission of ["stm_title_review_start", "task", "stm_title_review"]) {
        const before = host.requests.filter((request) => request.kind === "review-child").length
        const receipts = await host.dispatchViaMain({
          permission: [{ permission, pattern: "*", action: "deny" }],
        })
        assert.equal(receipts.dispatchStatus.status, "denied", permission)
        assert.equal(receipts.stateAtDispatch.backgroundReview, null, permission)
        assert.equal(
          host.requests.filter((request) => request.kind === "review-child").length,
          before,
          permission,
        )
      }
    },
    { compiledPlugin: true },
  )
})

test("compiled plugin honours transcript tool opt-ins and applies a keep", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const held = host.holdReviewer()
      const receipts = await host.dispatchViaMain()
      const reviewerRequest = await held
      assert.equal(reviewerRequest.kind, "review-child")
      assert.equal(reviewerRequest.promptHasToolCallRecords, true)
      assert.equal(reviewerRequest.promptHasToolResultRecords, true)
      assert.match(reviewerRequest.marker, /stm_title_lock/)

      host.releaseReviewer({ decision: "keep" })
      const resolved = await host.waitForReviewerResolution(receipts.titleBefore)
      assert.equal(resolved.title, receipts.titleBefore)
    },
    { compiledPlugin: true, includeToolCalls: true, includeToolResults: true },
  )
})

test("compiled plugin fails closed when the configured reviewer agent is unavailable", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const receipts = await host.dispatchViaMain()
      assert.equal(receipts.dispatchStatus.status, "disabled")
      assert.equal(receipts.dispatchStatus.reason, "reviewer-unavailable")
      assert.equal(receipts.stateAtDispatch.backgroundReview, null)
      assert.equal(host.requests.filter((request) => request.kind === "review-child").length, 0)
    },
    { compiledPlugin: true, reviewerAgent: "stm-missing-reviewer" },
  )
})

test("compiled plugin times out a held reviewer without changing the title", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const held = host.holdReviewer()
      const receipts = await host.dispatchViaMain()
      await held
      try {
        const failed = await host.waitForState(
          receipts.parentID,
          (state) => state.backgroundReview?.phase === "failed",
          20_000,
        )
        assert.equal(failed.backgroundReview?.failureCode, "background-timeout")
        assert.equal(await host.readParentTitle(), receipts.titleBefore)
        assert.equal(failed.backgroundReview?.stop === "pending" || failed.backgroundReview?.stop === "confirmed", true)
      } finally {
        try {
          host.releaseReviewer({ decision: "keep" })
        } catch {}
      }
      await wait(500)
      assert.equal(await host.readParentTitle(), receipts.titleBefore)
    },
    { compiledPlugin: true, reviewerTimeoutSeconds: 10 },
  )
})

test("compiled plugin manual lock revokes a held reviewer and blocks its rename", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const held = host.holdReviewer()
      const receipts = await host.dispatchViaMain()
      await held
      const locked = await host.lockParentViaMain()
      assert.equal(locked.status, "ok")
      assert.equal(locked.locked, true)
      const failed = await host.waitForState(
        receipts.parentID,
        (state) => state.locked && state.backgroundReview?.phase === "failed",
      )
      assert.equal(failed.locked, true)
      try {
        host.releaseReviewer({ decision: "rename", title: "Locked rename must not apply" })
      } catch {}
      await wait(1_000)
      assert.equal(await host.readParentTitle(), receipts.titleBefore)
      const state = host.readState(receipts.parentID)
      assert.equal(state.locked, true)
      assert.equal(state.backgroundReview?.phase, "failed")
    },
    { compiledPlugin: true },
  )
})

test("compiled plugin does not let a permissive reviewer bypass restrictive parent permissions", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const held = host.holdReviewer()
      const receipts = await host.dispatchViaMain({
        permission: [
          { permission: "bash", pattern: "*", action: "deny" },
          { permission: "edit", pattern: "*", action: "deny" },
        ],
      })
      const reviewerRequest = await held
      assert.deepEqual(reviewerRequest.toolNames, [])
      const activeState = await host.waitForState(
        receipts.parentID,
        (state) => typeof state.backgroundReview?.childSessionID === "string",
      )
      const childID = activeState.backgroundReview.childSessionID
      host.releaseReviewer({ decision: "keep" })
      const resolved = await host.waitForReviewerResolution(receipts.titleBefore)
      assert.equal(resolved.title, receipts.titleBefore)
      const childSession = await host.client.session.get({
        path: { id: childID },
        query: { directory: host.directory },
      })
      assert.equal(childSession.error, undefined)
      assert.deepEqual(childSession.data?.permission, [
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "*", pattern: "*", action: "deny" },
      ])
    },
    { compiledPlugin: true, reviewerAgent: "stm-probe-reviewer-permissive" },
  )
})

test("compiled plugin deduplicates a repeated dispatch and never applies malformed reviewer output", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const held = host.holdReviewer()
      const receipts = await host.dispatchViaMain()
      await held
      assert.equal(receipts.dispatchStatus.status, "queued")
      assert.equal(
        receipts.dispatchToolCount,
        2,
        JSON.stringify(
          host.requests.map((request) => ({
            kind: request.kind,
            hasToolResult: request.hasToolResult,
            response: request.response,
          })),
        ),
      )
      assert.equal(host.requests.filter((request) => request.kind === "review-child").length, 1)

      host.releaseReviewer({ decision: "keep" })
      const failed = await host.waitForState(
        receipts.parentID,
        (state) => state.backgroundReview?.phase === "failed",
      )
      assert.equal(failed.backgroundReview?.failureCode, "background-child-error")
      assert.equal(await host.readParentTitle(), receipts.titleBefore)
    },
    { compiledPlugin: true, duplicateDispatch: true, invalidReviewerOutput: true },
  )
})
