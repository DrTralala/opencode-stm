import assert from "node:assert/strict"
import test from "node:test"
import {
  REVIEWER_SCHEMA,
  assertRestrictedChildReceipts,
  withLoopbackHost,
} from "./opencode-loopback.mjs"

function assertAsyncTextValid(result, host) {
  assert.equal(result.create.ackStatus, 204)
  assert.equal(result.create.childDirectory, host.directory)
  assert.deepEqual(result.create.childPermission, [
    { permission: "*", pattern: "*", action: "deny" },
  ])

  assert.deepEqual(result.held.toolNames, [])
  assert.equal(result.held.systemMentionsStructuredOutput, false)
  assert.equal(result.heldStillBeforeParentTurn, true)
  assert.equal(result.heldStillBeforeRelease, true)

  assert.notEqual(result.automaticParentContinuation.requestId, null)
  assert.equal(result.automaticParentContinuation.requestKind, "async-create")
  assert.equal(result.automaticParentContinuation.hasToolResult, true)
  assert.equal(result.parentTurn.requestKind, "parent-turn")
  assert.notEqual(result.parentTurn.requestId, null)
  assert.notEqual(result.parentTurn.requestId, result.automaticParentContinuation.requestId)
  assert.equal(result.parentTurn.childHeldAtRequest, true)
  assert.equal(result.parentTurn.assistantCompleted, true)
  assert.equal(result.parentTurn.assistantError, null)

  assert.equal(result.completion.snapshot.assistantCompleted, true)
  assert.equal(result.completion.snapshot.assistantError, null)
  assert.equal(result.completion.snapshot.parentReadError, null)
  assert.equal(result.completion.parentMessagesUnchanged, true)
  assert.deepEqual(result.completion.newParentMessageIDs, [])
  assert.equal(result.completion.automaticParentWakeCount, 0)
  assert.deepEqual(result.completion.newProviderRequestIDsAfterRelease, [])
  assert.equal(result.completion.automaticParentProviderRequestCount, 0)

  // Direct event observation for the isolated child-completion window. This
  // fails if the observer-start control is not read or no runtime events are
  // observed, so the stored-ID/provider-request checks cannot mask a bypass.
  assert.equal(result.completion.snapshot.observerStartAt, result.observerStart.startAt)
  assert.notEqual(result.completion.snapshot.observerSeenAt, null)
  assert.ok(result.completion.snapshot.observerEventCount > 0)
  assert.ok(result.completion.snapshot.observerChildEventCount > 0)
  assert.equal(result.completion.snapshot.observerParentEventCount, 0)
  assert.deepEqual(result.completion.snapshot.observerParentEvents, [])

  assert.equal(result.fetch.messagesReadStatus, 200)
  assert.equal(result.fetch.messagesReadError, null)
  assert.equal(result.fetch.promptTextMatches, true)
  assert.equal(result.fetch.parentIDCorrelated, true)
  assert.equal(result.fetch.assistantCompleted, true)
  assert.equal(result.fetch.assistantError, null)
  assert.equal(result.fetch.rawVisibleText, '{"decision":"keep"}')
  assert.deepEqual(result.fetch.structured, { decision: "keep" })
  assert.equal(result.fetch.validationError, null)
  assert.equal(result.fetch.foreignUserMessageCount, 0)
  assert.equal(result.fetch.foreignAssistantMessageCount, 0)
  assert.equal(result.fetch.assistantAgent, "stm-probe-reviewer-deny")
  assert.equal(result.fetch.assistantProviderID, "probe")
  assert.equal(result.fetch.assistantModelID, "mock")

  assert.ok(result.fetchRequestIDs.length > 0)
  assert.ok(result.fetchRequestIDs.every((id) =>
    result.completion.providerRequestIDsAtCompletion.every((before) => id > before)))
  assert.deepEqual(result.fetchRequestKinds, result.fetchRequestKinds.map(() => "async-fetch"))
}

test("raw child is restricted, structured and does not notify parent", async (t) => {
  await withLoopbackHost(t, async (host) => {
    const receipts = await host.probeRestrictedChild()
    assert.deepEqual(receipts.structured, { decision: "keep" })
    assert.deepEqual(receipts.hostStructured, { decision: "keep" })
    assert.equal(receipts.validationError, null)
    assert.equal(receipts.selectedAgent, "stm-probe-reviewer")
    assert.equal(receipts.parentMessageCountAfter, receipts.parentMessageCountBefore)
    assert.equal(receipts.parentWakeCount, 0)
    assert.equal(receipts.unrelatedToolExecuted, false)
    assert.equal(receipts.injectedClientTransportVerified, true)

    assertRestrictedChildReceipts(receipts)
    assert.equal(host.serverPasswordEnabled, true)
    assert.equal(receipts.directory, host.directory)
    assert.equal(receipts.childDirectory, host.directory)
    assert.equal(receipts.childParentID, receipts.parentSessionID)
    assert.equal(receipts.childAgent, "stm-probe-reviewer")
    assert.equal(receipts.childModel.id, "mock")
    assert.equal(receipts.childModel.providerID, "probe")
    assert.equal(receipts.childModel.variant, "default")
    assert.deepEqual(receipts.childPermission, [
      { permission: "StructuredOutput", pattern: "*", action: "allow" },
    ])
    assert.equal(receipts.assistantCwd, host.directory)
    // An isolated non-git project is registered under the global project, whose
    // worktree is "/". The scoped directory evidence is childDirectory/cwd.
    assert.equal(receipts.assistantRoot, "/")
    assert.equal(receipts.promptParentIDCorrelated, true)
    assert.equal(receipts.assistantCompleted, true)
    assert.equal(receipts.assistantError, null)
    assert.equal(receipts.hostileToolCallObserved, true)
    assert.equal(receipts.hostileToolOffered, false)
    assert.equal(receipts.hostileToolPartStatus, "error")

    const structuredRequest = host.requests.find((request) => request.kind === "structured")
    assert.ok(structuredRequest, "structured reviewer request was not observed")
    assert.equal(structuredRequest.structuredTool.name, "StructuredOutput")
    assert.deepEqual(structuredRequest.structuredTool.parameters, REVIEWER_SCHEMA)
    assert.deepEqual(structuredRequest.toolNames, ["StructuredOutput"])
    assert.equal(structuredRequest.toolChoice, "required")
    assert.equal(structuredRequest.stream, true)

    const hostileRequest = host.requests.find((request) => request.kind === "hostile")
    assert.ok(hostileRequest, "hostile reviewer request was not observed")
    assert.deepEqual(hostileRequest.toolNames, [])
  })
})

test("the same restricted child path works without a server password", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const receipts = await host.probeRestrictedChild()
      assert.equal(host.serverPasswordEnabled, false)
      assertRestrictedChildReceipts(receipts)
      assert.equal(receipts.injectedClientTransportVerified, true)
    },
    { serverPassword: false },
  )
})

test("pagination, message IDs, correlation and raw permission shapes", async (t) => {
  await withLoopbackHost(t, async (host) => {
    const facts = await host.collectPaginationAndIdFacts()
    assert.equal(facts.seedCount, 10)
    assert.equal(facts.full.length, facts.seedCount)
    assert.deepEqual(
      facts.full.map((message) => message.info.id),
      facts.seedIDs,
    )

    // Pages are ascending within the page. The next cursor is an opaque
    // base64 JSON {id,time} pointing at the oldest item in the page.
    assert.deepEqual(facts.firstPage.ids, facts.seedIDs.slice(-4))
    assert.equal(facts.firstPage.headerMessageID, facts.seedIDs[6])
    assert.deepEqual(facts.secondPage.ids, facts.seedIDs.slice(-8, -4))
    assert.equal(facts.secondPage.headerMessageID, facts.seedIDs[2])
    assert.deepEqual(facts.thirdPage.ids, facts.seedIDs.slice(0, 2))
    assert.equal(facts.thirdPage.header, null)
    assert.equal(facts.terminalCursor, null)

    // A raw message ID is not a valid `before` cursor. The boundary has to be
    // found through a page: a limit-2 newest page ends at the dispatching user
    // message and its header excludes that message and the assistant reply.
    assert.equal(facts.boundary.rawBeforeStatus, 400)
    assert.equal(facts.boundary.rawBeforeRejected, true)
    assert.equal(facts.boundary.beforeWithoutLimitStatus, 400)
    assert.deepEqual(facts.boundary.pageIDs, [facts.dispatchMessageID, facts.assistant.id])
    assert.equal(facts.boundary.pageHeaderMessageID, facts.dispatchMessageID)
    assert.deepEqual(facts.boundary.olderIDs, facts.boundary.boundarySeedIDs)
    assert.equal(facts.boundary.olderIDs.includes(facts.dispatchMessageID), false)

    assert.match(facts.seedIDs.join(","), /^msg_[0-9A-HJKMNP-TV-Z]{26}(,msg_[0-9A-HJKMNP-TV-Z]{26})*$/)
    assert.equal(facts.explicitMessageID, facts.explicitReceiptID)
    assert.match(facts.explicitMessageID, /^msg_[0-9A-HJKMNP-TV-Z]{26}$/)

    assert.equal(facts.assistant.parentID, facts.dispatchMessageID)
    assert.equal(typeof facts.assistant.time.completed, "number")
    assert.equal(facts.assistant.error, undefined)
    assert.equal(facts.assistant.finish, "stop")
    assert.equal(facts.assistant.agent, "stm-probe-parent")
    assert.equal(facts.assistant.mode, "stm-probe-parent")
    assert.equal(facts.assistant.providerID, "probe")
    assert.equal(facts.assistant.modelID, "mock")
    assert.equal(facts.assistant.variant, undefined)
    assert.equal(facts.assistant.path.cwd, host.directory)
    assert.equal(facts.assistant.path.root, "/")
    // Runtime-generated IDs are msg_ + 26 alphanumerics (not the uppercase-ULID
    // spelling accepted for explicit prompt message IDs).
    assert.match(facts.assistant.id, /^msg_[A-Za-z0-9]{26}$/)
    for (const id of facts.boundary.boundarySeedIDs) {
      assert.match(id, /^msg_[A-Za-z0-9]{26}$/)
    }

    assert.ok(Array.isArray(facts.session.permission), "session permission should be a ruleset array")
    assert.deepEqual(facts.session.permission, [
      { permission: "bash", pattern: "*", action: "deny" },
    ])
    assert.equal(facts.session.agent, "stm-probe-parent")
    assert.deepEqual(facts.session.model, {
      id: "mock",
      providerID: "probe",
      variant: "default",
    })
    assert.equal(facts.session.directory, host.directory)
    assert.match(facts.session.version, /^\d+\.\d+\.\d+/)
  })
})

test("holdReviewer gates completion without a sleep", async (t) => {
  await withLoopbackHost(t, async (host) => {
    const reached = host.holdReviewer()
    const probe = host.probeRestrictedChild()
    let settled = false
    probe.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    const request = await reached
    assert.equal(request.kind, "structured")
    await Promise.resolve()
    assert.equal(settled, false, "probe completed while the reviewer was held")

    host.releaseReviewer("keep")
    const receipts = await probe
    assert.deepEqual(receipts.structured, { decision: "keep" })
    assert.equal(receipts.assistantError, null)
  })
})

test("malformed structured output fails closed (negative control)", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const receipts = await host.probeRestrictedChild()
      assert.equal(receipts.structured, null)
      assert.equal(receipts.validationError, "invalid-structured-output")
      assert.deepEqual(receipts.hostStructured, { decision: "not-a-valid-decision" })
      assert.equal(receipts.assistantCompleted, true)
      // The host accepts the malformed call without a StructuredOutputError;
      // only the explicit caller-side validator rejects it.
      assert.equal(receipts.assistantError, null)
      assert.equal(receipts.injectedClientTransportVerified, true)
      assert.equal(receipts.unrelatedToolExecuted, false)

      const request = host.requests.find((entry) => entry.kind === "structured")
      assert.ok(request, "structured request was not observed")
      assert.equal(request.response, "structured-malformed")
    },
    { malformedStructured: true },
  )
})

test("amended: promptAsync raw child visible JSON is retrievable", async (t) => {
  await withLoopbackHost(t, async (host) => {
    const result = await host.probeAsyncTextChild()
    assert.equal(host.serverPasswordEnabled, true)
    assertAsyncTextValid(result, host)
  })
})

test("amended: promptAsync path works without a server password", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const result = await host.probeAsyncTextChild()
      assert.equal(host.serverPasswordEnabled, false)
      assertAsyncTextValid(result, host)
    },
    { serverPassword: false },
  )
})

test("amended: malformed visible JSON is rejected", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const result = await host.probeAsyncTextChild()
      assert.equal(result.create.ackStatus, 204)
      assert.equal(result.fetch.validationError, "invalid-json")
      assert.equal(result.fetch.structured, null)
      assert.match(result.fetch.rawVisibleText, /^Here is the JSON: /)
      assert.equal(result.fetch.parentIDCorrelated, true)
      assert.equal(result.fetch.assistantCompleted, true)
      assert.equal(result.fetch.assistantError, null)
    },
    { malformedAsyncText: true },
  )
})

test("amended: assistant error is rejected", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const result = await host.probeAsyncTextChild()
      assert.equal(result.create.ackStatus, 204)
      assert.equal(result.fetch.validationError, "assistant-error")
      assert.equal(result.fetch.structured, null)
      assert.notEqual(result.fetch.assistantError, null)
    },
    { asyncTextError: true },
  )
})

test("amended: hostile tool cannot execute on the async deny-all child", async (t) => {
  await withLoopbackHost(
    t,
    async (host) => {
      const result = await host.probeAsyncTextChild()
      assert.equal(result.create.ackStatus, 204)
      assert.deepEqual(result.held.toolNames, [])
      assert.equal(result.fetch.hostileToolCallObserved, true)
      assert.equal(result.fetch.hostileToolPartStatus, "error")
      assert.equal(result.fetch.unrelatedToolExecuted, false)
      assert.equal(result.fetch.validationError, null)
      assert.deepEqual(result.fetch.structured, { decision: "keep" })

      const hostileRequest = host.requests.find(
        (request) => request.kind === "async-text" && request.response === "async-text-hostile",
      )
      assert.ok(hostileRequest, "hostile async-text request was not observed")
      assert.deepEqual(hostileRequest.toolNames, [])
    },
    { asyncTextHostile: true },
  )
})

test("amended: foreign child prompt is rejected", async (t) => {
  await withLoopbackHost(t, async (host) => {
    const result = await host.probeAsyncForeignPrompt()
    assert.equal(result.create.ackStatus, 204)
    assert.equal(result.heldStillBeforeForeign, true)
    assert.equal(result.foreign.ackStatus, 204)
    assert.equal(result.fetch.validationError, "foreign-prompt")
    assert.equal(result.fetch.structured, null)
    assert.ok(result.fetch.foreignUserMessageCount >= 1)
  })
})

test("original JSON-schema message retrieval failure is preserved", async (t) => {
  await withLoopbackHost(t, async (host) => {
    const result = await host.probeSchemaReadFailure()
    assert.equal(result.promptStatus, 200)
    assert.equal(result.assistantError?.name, "StructuredOutputError")
    assert.equal(result.messagesReadStatus, 400)
    assert.match(JSON.stringify(result.messagesReadError), /Expected OutputFormatJsonSchema/)
    assert.equal(result.messagesReadDataPresent, false)
  })
})
