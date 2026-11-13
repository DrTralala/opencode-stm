// test/sdk.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  MESSAGE_PAGE_LIMIT,
  createReviewChild,
  createRootCache,
  page,
  promptReviewChild,
  readReviewCompletion,
  readReviewExecutionContext,
  readSession,
  stopReviewChild,
  writeTitle,
  type PermissionRule,
  type ReviewAgent,
} from "../src/sdk.js"
import { fakeClient, headerResponse, type FakeHandlers } from "./fakes.js"

test("readSession rejects response data whose id does not match the request", async () => {
  const { client } = fakeClient({
    get: async () => ({ data: { id: "ses_other", title: "T" } }),
  })
  const result = await readSession(client, "ses_1")
  assert.equal(result.ok, false)
})

test("readSession treats a returned error value as failure and never throws", async () => {
  const { client, calls } = fakeClient({ get: async () => ({ error: { message: "boom" } }) })
  const result = await readSession(client, "ses_1")
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason.includes("boom"), false)
  assert.equal(calls.length, 1)
})

test("readSession treats missing data as failure", async () => {
  const { client } = fakeClient({ get: async () => ({}) })
  assert.equal((await readSession(client, "ses_1")).ok, false)
})

test("writeTitle succeeds only when data echoes the target id", async () => {
  const ok = fakeClient({ update: async () => ({ data: { id: "ses_1", title: "New" } }) })
  assert.equal((await writeTitle(ok.client, "ses_1", "New")).ok, true)
  const wrong = fakeClient({ update: async () => ({ data: { id: "ses_other", title: "New" } }) })
  assert.equal((await writeTitle(wrong.client, "ses_1", "New")).ok, false)
})

test("page sends limit 8 and omits before without a cursor", async () => {
  const { client, calls } = fakeClient({
    messages: async () => ({ data: [], response: headerResponse("x-next-cursor", null) }),
  })
  await page(client, "ses_1", undefined)
  assert.deepEqual(calls[0]?.options.query, { limit: MESSAGE_PAGE_LIMIT })
})

test("page sends before when a cursor is provided and reads x-next-cursor", async () => {
  const { client, calls } = fakeClient({
    messages: async () => ({ data: [], response: headerResponse("x-next-cursor", "cursor-9") }),
  })
  const result = await page(client, "ses_1", "cursor-4")
  assert.deepEqual(calls[0]?.options.query, { limit: MESSAGE_PAGE_LIMIT, before: "cursor-4" })
  assert.equal(result.ok && result.value.nextCursor, "cursor-9")
})

test("page returns a bounded failure when the response header is absent on error", async () => {
  const { client } = fakeClient({ messages: async () => ({ error: { message: "raw sdk detail" } }) })
  const result = await page(client, "ses_1", undefined)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason.includes("raw sdk detail"), false)
})

test("root cache caches, evicts and clears", async () => {
  let calls = 0
  const { client } = fakeClient({
    get: async (options) => {
      calls += 1
      return { data: { id: options.path.id, title: "T", parentID: "ses_parent" } }
    },
  })
  const cache = createRootCache(client, 2)
  const first = await cache.isRoot("ses_1")
  const second = await cache.isRoot("ses_1")
  assert.equal(first.ok && second.ok && second.value, false)
  assert.equal(calls, 1)
  await cache.isRoot("ses_2")
  await cache.isRoot("ses_3")
  await cache.isRoot("ses_1")
  assert.equal(calls, 4)
  cache.clear()
  await cache.isRoot("ses_1")
  assert.equal(calls, 5)
})

// Step 6 table cases.

test("readSession handles a rejected promise", async () => {
  const { client, calls } = fakeClient({
    get: async () => {
      throw new Error("raw transport failure")
    },
  })
  const result = await readSession(client, "ses_1")
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason.includes("raw transport failure"), false)
  assert.ok(result.reason.length > 0 && result.reason.length <= 120)
  assert.equal(calls.length, 1)
})

test("readSession passes the abort signal", async () => {
  const controller = new AbortController()
  let seen: { signal?: unknown } | undefined
  const { client } = fakeClient({
    get: async (options) => {
      seen = options
      return { data: { id: "ses_1", title: "T" } }
    },
  })
  const result = await readSession(client, "ses_1", controller.signal)
  assert.equal(result.ok, true)
  assert.equal(seen?.signal, controller.signal)
})

test("page surfaces a missing response object safely", async () => {
  const { client } = fakeClient({ messages: async () => ({ data: [] }) })
  const result = await page(client, "ses_1", undefined)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.nextCursor, null)
})

test("page never follows a Link header", async () => {
  const { client, calls } = fakeClient({
    messages: async () => ({
      data: [],
      response: {
        headers: {
          get: (name: string) => {
            if (name.toLowerCase() === "x-next-cursor") return "cursor-9"
            if (name.toLowerCase() === "link") return '</session/ses_1/message?before=cursor-4>; rel="next"'
            return null
          },
        },
      },
    }),
  })
  const result = await page(client, "ses_1", "cursor-4")
  assert.equal(result.ok && result.value.nextCursor, "cursor-9")
  assert.equal(calls.length, 1)
})

test("page handles a rejected promise", async () => {
  const { client, calls } = fakeClient({
    messages: async () => {
      throw new Error("raw page failure")
    },
  })
  const result = await page(client, "ses_1", undefined)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason.includes("raw page failure"), false)
  assert.equal(calls.length, 1)
})

test("root cache remembers without an SDK call", async () => {
  const { client, calls } = fakeClient({})
  const cache = createRootCache(client, 2)
  cache.remember("ses_1", true)
  const result = await cache.isRoot("ses_1")
  assert.equal(result.ok && result.value, true)
  assert.equal(calls.length, 0)
})

test("root cache invalidate forces a re-read", async () => {
  let reads = 0
  const { client } = fakeClient({
    get: async () => {
      reads += 1
      return { data: { id: "ses_1", title: "T" } }
    },
  })
  const cache = createRootCache(client, 2)
  assert.equal((await cache.isRoot("ses_1")).ok, true)
  assert.equal(reads, 1)
  cache.invalidate("ses_1")
  assert.equal((await cache.isRoot("ses_1")).ok, true)
  assert.equal(reads, 2)
})

test("root cache propagates read failure", async () => {
  let failing = true
  let reads = 0
  const { client } = fakeClient({
    get: async () => {
      reads += 1
      if (failing) return { error: { message: "boom" } }
      return { data: { id: "ses_1", title: "T", parentID: "ses_parent" } }
    },
  })
  const cache = createRootCache(client, 2)
  const first = await cache.isRoot("ses_1")
  assert.equal(first.ok, false)
  assert.equal(reads, 1)
  failing = false
  const second = await cache.isRoot("ses_1")
  assert.equal(second.ok && second.value, false)
  assert.equal(reads, 2)
})

// Bounded LRU insertion on the remember path.

test("root cache bounds remembered entries and refetches the evicted key", async () => {
  let reads = 0
  const { client, calls } = fakeClient({
    get: async (options) => {
      reads += 1
      return { data: { id: options.path.id, title: "T" } }
    },
  })
  const cache = createRootCache(client, 2)
  cache.remember("ses_1", true)
  cache.remember("ses_2", true)
  cache.remember("ses_3", true)
  // ses_1 is the oldest and was evicted by the bounded insert, so it must be re-read.
  const evicted = await cache.isRoot("ses_1")
  assert.equal(evicted.ok, true)
  if (evicted.ok) assert.equal(evicted.value, true)
  assert.equal(reads, 1)
  // The most recent remembered key is still cached.
  const fresh = await cache.isRoot("ses_3")
  assert.equal(fresh.ok, true)
  if (fresh.ok) assert.equal(fresh.value, true)
  assert.equal(reads, 1)
  assert.equal(calls.length, 1)
})

test("root cache remember refreshes an existing key's recency", async () => {
  let reads = 0
  const { client } = fakeClient({
    get: async (options) => {
      reads += 1
      return { data: { id: options.path.id, title: "T" } }
    },
  })
  const cache = createRootCache(client, 2)
  cache.remember("ses_1", true)
  cache.remember("ses_2", false)
  // Re-remembering ses_1 refreshes it, so ses_2 becomes the oldest entry.
  cache.remember("ses_1", false)
  cache.remember("ses_3", false)
  const refreshed = await cache.isRoot("ses_1")
  assert.equal(refreshed.ok, true)
  if (refreshed.ok) assert.equal(refreshed.value, false)
  assert.equal(reads, 0)
  const evicted = await cache.isRoot("ses_2")
  assert.equal(evicted.ok, true)
  assert.equal(reads, 1)
})

// Write-path argument and no-retry checks.

test("writeTitle sends the target id and title exactly once", async () => {
  const { client, calls } = fakeClient({
    update: async () => ({ data: { id: "ses_1", title: "New" } }),
  })
  const result = await writeTitle(client, "ses_1", "New")
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value.id, "ses_1")
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.options.path, { id: "ses_1" })
  assert.deepEqual(calls[0]?.options.body, { title: "New" })
})

test("writeTitle does not retry after an explicit error", async () => {
  const { client, calls } = fakeClient({ update: async () => ({ error: { message: "raw update detail" } }) })
  const result = await writeTitle(client, "ses_1", "New")
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason.includes("raw update detail"), false)
  assert.equal(calls.length, 1)
})

test("writeTitle handles a rejected promise without retrying", async () => {
  const { client, calls } = fakeClient({
    update: async () => {
      throw new Error("raw update transport failure")
    },
  })
  const result = await writeTitle(client, "ses_1", "New")
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason.includes("raw update transport failure"), false)
  assert.equal(calls.length, 1)
})

// Background review SDK adapter.

const PARENT = "ses_parent"
const CHILD = "ses_child"
const DISPATCH = "msg_dispatch"
const PROMPT = "msg_prompt"
const CALLER = "build"
const REVIEWER = "title-worker"
const REVIEWER_MODEL = { providerID: "probe", modelID: "reviewer" }
const PROVIDER_CATALOG = {
  all: [
    { id: "probe", models: { reviewer: { id: "reviewer" }, "nested/model": { id: "nested/model" } } },
    { id: "parent-provider", models: { "parent-model": { id: "parent-model" } } },
    { id: "user-provider", models: { "user-model": { id: "user-model" } } },
  ],
  connected: ["probe", "parent-provider", "user-provider"],
  default: {},
}

type ProviderListHandler = (input?: { signal?: AbortSignal }) => Promise<{ data?: unknown; error?: unknown }>

function setProviderList(client: ReturnType<typeof fakeClient>["client"], list: ProviderListHandler): void {
  const target = client as unknown as { provider: { list: ProviderListHandler } }
  target.provider = { list }
}

function ensureProviderList(client: ReturnType<typeof fakeClient>["client"]): void {
  const target = client as unknown as { provider?: { list: ProviderListHandler } }
  if (target.provider === undefined) {
    setProviderList(client, async () => ({ data: PROVIDER_CATALOG }))
  }
}

function agentFixture(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    description: "",
    mode: "subagent",
    builtIn: false,
    permission: { edit: "deny", bash: {}, tools: {} },
    tools: {},
    options: {},
    ...extra,
  }
}

function dispatchFixture(info: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    info: {
      id: DISPATCH,
      sessionID: PARENT,
      role: "assistant",
      parentID: "msg_user",
      providerID: "parent-provider",
      modelID: "parent-model",
      time: { created: 1, completed: 2 },
      ...info,
    },
    parts: [],
  }
}

function runContext(
  client: ReturnType<typeof fakeClient>["client"],
  overrides: Partial<{
    parentID: string
    messageID: string
    callerAgent: string
    reviewerAgent: string
    model: string
  }> = {},
  signal: AbortSignal = new AbortController().signal,
) {
  ensureProviderList(client)
  return readReviewExecutionContext(
    client,
    {
      parentID: PARENT,
      messageID: DISPATCH,
      callerAgent: CALLER,
      reviewerAgent: REVIEWER,
      ...overrides,
    },
    signal,
  )
}

test("review context inherits the dispatch model instead of an external reviewer model", async () => {
  const controller = new AbortController()
  const { client, calls } = fakeClient({
    agents: async () => ({
      data: [
        agentFixture(CALLER, {
          mode: "primary",
          model: { providerID: "caller-provider", modelID: "caller-model" },
        }),
        agentFixture(REVIEWER, { model: REVIEWER_MODEL, variant: "high" }),
      ],
    }),
    message: async () => ({ data: dispatchFixture() }),
    get: async () => ({
      data: {
        id: PARENT,
        title: "Parent",
        permission: [
          { permission: "bash", pattern: "*", action: "deny" },
          { permission: "edit", pattern: "*", action: "allow" },
          { permission: "webfetch", pattern: "*", action: "ask" },
        ],
      },
    }),
  })
  const result = await runContext(client, {}, controller.signal)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, {
    agent: { name: REVIEWER, model: { providerID: "parent-provider", modelID: "parent-model" } },
    childPermissions: [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "ask" },
      { permission: "*", pattern: "*", action: "deny" },
    ],
    dispatchParentID: "msg_user",
  })
  assert.deepEqual(calls.map((call) => call.method), ["agents", "message", "get"])
  assert.equal(calls[0]?.options.signal, controller.signal)
  assert.deepEqual(calls[1]?.options.path, { id: PARENT, messageID: DISPATCH })
  assert.equal(calls[1]?.options.signal, controller.signal)
  assert.deepEqual(calls[2]?.options.path, { id: PARENT })
  assert.equal(calls[2]?.options.signal, controller.signal)
})

test("review context falls back to the dispatch assistant model instead of the session model", async () => {
  const { client } = fakeClient({
    agents: async () => ({
      data: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER)],
    }),
    message: async () => ({ data: dispatchFixture({ variant: "parent-variant" }) }),
    get: async () => ({
      data: {
        id: PARENT,
        title: "Parent",
        model: { id: "session-model", providerID: "session-provider", variant: "default" },
      },
    }),
  })
  const result = await runContext(client)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value.agent, {
    name: REVIEWER,
    model: { providerID: "parent-provider", modelID: "parent-model" },
    variant: "parent-variant",
  })
  assert.equal(result.value.dispatchParentID, "msg_user")
  assert.deepEqual(result.value.childPermissions, [
    { permission: "*", pattern: "*", action: "deny" },
  ])
})

test("review context uses an explicit configured model exactly and does not inherit another variant", async () => {
  const controller = new AbortController()
  let providerCalls = 0
  let providerSignal: AbortSignal | undefined
  const { client } = fakeClient({
    agents: async () => ({ data: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER, {
      model: REVIEWER_MODEL,
      variant: "external-variant",
    })] }),
    message: async () => ({ data: dispatchFixture({ variant: "parent-variant" }) }),
    get: async () => ({ data: { id: PARENT, title: "Parent" } }),
  })
  setProviderList(client, async (input) => {
    providerCalls += 1
    providerSignal = input?.signal
    return { data: PROVIDER_CATALOG }
  })

  const result = await runContext(client, { model: "probe/nested/model" }, controller.signal)

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.value.agent, {
      name: REVIEWER,
      model: { providerID: "probe", modelID: "nested/model" },
    })
    assert.equal(result.value.dispatchParentID, "msg_user")
  }
  assert.equal(providerCalls, 1)
  assert.equal(providerSignal, controller.signal)
})

test("review context rejects malformed or unavailable explicit models without falling back", async () => {
  const cases: Array<{
    name: string
    model: string
    catalog?: unknown
    failure?: "returned" | "thrown"
  }> = [
    { name: "malformed model setting", model: "probe/ nested/model", catalog: PROVIDER_CATALOG },
    { name: "missing exact model", model: "probe/not-in-catalog", catalog: PROVIDER_CATALOG },
    {
      name: "disconnected provider",
      model: "probe/nested/model",
      catalog: { ...PROVIDER_CATALOG, connected: ["parent-provider", "user-provider"] },
    },
    { name: "malformed catalogue", model: "probe/nested/model", catalog: { all: [], connected: "probe" } },
    { name: "provider catalogue rejection", model: "probe/nested/model", failure: "returned" },
    { name: "provider catalogue transport failure", model: "probe/nested/model", failure: "thrown" },
  ]

  for (const item of cases) {
    const { client, calls } = fakeClient({
      agents: async () => ({ data: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER, {
        model: REVIEWER_MODEL,
        variant: "external-variant",
      })] }),
      message: async () => ({ data: dispatchFixture({ variant: "parent-variant" }) }),
      get: async () => ({ data: { id: PARENT, title: "Parent" } }),
    })
    let providerCalls = 0
    setProviderList(client, async () => {
      providerCalls += 1
      if (item.failure === "returned") return { error: { message: "raw provider catalogue secret" } }
      if (item.failure === "thrown") throw new Error("raw provider transport detail")
      return { data: item.catalog }
    })

    const result = await runContext(client, { model: item.model })

    assert.equal(result.ok, false, item.name)
    if (!result.ok) {
      assert.match(result.reason, /review\.reviewer\.model/, item.name)
      assert.equal(result.reason.includes("not-in-catalog"), false, item.name)
      assert.equal(result.reason.includes("raw"), false, item.name)
    }
    assert.equal(providerCalls, item.name === "malformed model setting" ? 0 : 1, item.name)
    assert.deepEqual(
      calls.map((call) => call.method),
      item.name === "malformed model setting" ? [] : ["agents", "message"],
      item.name,
    )
  }
})

test("review context rejects user messages as dispatches", async () => {
  const { client } = fakeClient({
    agents: async () => ({ data: [agentFixture(REVIEWER)] }),
    message: async () => ({
      data: {
        info: {
          id: DISPATCH,
          sessionID: PARENT,
          role: "user",
          time: { created: 1 },
          model: { providerID: "user-provider", modelID: "user-model" },
        },
        parts: [],
      },
    }),
    get: async () => ({ data: { id: PARENT, title: "Parent" } }),
  })
  const result = await runContext(client, { callerAgent: REVIEWER })
  assert.equal(result.ok, false)
})

test("review context rejects disabled, missing and primary-only agents", async () => {
  const cases: Array<{ name: string; agents: unknown[]; callerAgent?: string }> = [
    {
      name: "disabled reviewer",
      agents: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER, { disable: true })],
    },
    {
      name: "missing reviewer",
      agents: [agentFixture(CALLER, { mode: "primary" })],
    },
    {
      name: "primary-only reviewer",
      agents: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER, { mode: "primary" })],
    },
    {
      name: "missing caller",
      agents: [agentFixture(REVIEWER)],
    },
    {
      name: "malformed reviewer mode",
      agents: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER, { mode: "other" })],
    },
  ]
  for (const item of cases) {
    const { client, calls } = fakeClient({ agents: async () => ({ data: item.agents }) })
    const result = await runContext(client, { callerAgent: item.callerAgent ?? CALLER })
    assert.equal(result.ok, false, item.name)
    assert.equal(calls.length, 1, item.name)
  }
})

test("review context sanitises agent, dispatch-message and session-read failures", async () => {
  const cases: Array<{ name: string; handlers: FakeHandlers }> = [
    {
      name: "agent rejection",
      handlers: {
        agents: async () => ({ error: { message: "raw agent secret" } }),
      },
    },
    {
      name: "agent transport failure",
      handlers: {
        agents: async () => {
          throw new Error("raw agent throw")
        },
      },
    },
    {
      name: "dispatch rejection",
      handlers: {
        agents: async () => ({
          data: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER)],
        }),
        message: async () => ({ error: { message: "raw message secret" } }),
      },
    },
    {
      name: "session rejection",
      handlers: {
        agents: async () => ({
          data: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER)],
        }),
        message: async () => ({ data: dispatchFixture() }),
        get: async () => ({ error: { message: "raw session secret" } }),
      },
    },
  ]
  for (const item of cases) {
    const { client } = fakeClient(item.handlers)
    const result = await runContext(client)
    assert.equal(result.ok, false, item.name)
    if (result.ok) continue
    assert.equal(result.reason.includes("raw"), false, item.name)
  }
})

test("review context rejects malformed agent, dispatch and permission data", async () => {
  const cases: Array<{ name: string; handlers: FakeHandlers }> = [
    {
      name: "agents not an array",
      handlers: { agents: async () => ({ data: { agents: [] } }) },
    },
    {
      name: "dispatch id mismatch",
      handlers: {
        agents: async () => ({ data: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER)] }),
        message: async () => ({ data: dispatchFixture({ id: "msg_other" }) }),
      },
    },
    {
      name: "dispatch session mismatch",
      handlers: {
        agents: async () => ({ data: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER)] }),
        message: async () => ({ data: dispatchFixture({ sessionID: "ses_other" }) }),
      },
    },
    {
      name: "dispatch is not an assistant",
      handlers: {
        agents: async () => ({ data: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER)] }),
        message: async () => ({ data: dispatchFixture({ role: "user" }) }),
      },
    },
    {
      name: "dispatch parent is missing",
      handlers: {
        agents: async () => ({ data: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER)] }),
        message: async () => ({ data: dispatchFixture({ parentID: undefined }) }),
      },
    },
    {
      name: "permission not an array",
      handlers: {
        agents: async () => ({ data: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER)] }),
        message: async () => ({ data: dispatchFixture() }),
        get: async () => ({ data: { id: PARENT, title: "Parent", permission: "deny" } }),
      },
    },
    {
      name: "permission action invalid",
      handlers: {
        agents: async () => ({ data: [agentFixture(CALLER, { mode: "primary" }), agentFixture(REVIEWER)] }),
        message: async () => ({ data: dispatchFixture() }),
        get: async () => ({
          data: {
            id: PARENT,
            title: "Parent",
            permission: [{ permission: "bash", pattern: "*", action: "sometimes" }],
          },
        }),
      },
    },
  ]
  for (const item of cases) {
    const { client } = fakeClient(item.handlers)
    const result = await runContext(client)
    assert.equal(result.ok, false, item.name)
  }
})

test("createReviewChild creates a restricted child with the agent, attempt title and final deny-all", async () => {
  const controller = new AbortController()
  const { client, calls } = fakeClient({
    create: async () => ({ data: { id: CHILD, parentID: PARENT } }),
  })
  const agent: ReviewAgent = { name: REVIEWER, model: REVIEWER_MODEL }
  const permissions: PermissionRule[] = [
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "*", action: "allow" },
  ]
  const result = await createReviewChild(
    client,
    { parentID: PARENT, agent, permissions, attemptID: "attempt-1" },
    controller.signal,
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.value, { id: CHILD })
  const call = calls[0]
  assert.equal(call?.method, "create")
  assert.deepEqual(call?.options.body, {
    parentID: PARENT,
    title: "STM title review attempt-1",
    agent: REVIEWER,
    permission: [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "*", pattern: "*", action: "deny" },
    ],
  })
  assert.equal(call?.options.body.format, undefined)
  assert.equal(call?.options.signal, controller.signal)
})

test("createReviewChild rejects malformed responses and sanitises failures", async () => {
  const cases: Array<{ name: string; handler: FakeHandlers["create"] }> = [
    { name: "missing data", handler: async () => ({}) },
    { name: "missing id", handler: async () => ({ data: { parentID: PARENT } }) },
    { name: "empty id", handler: async () => ({ data: { id: "", parentID: PARENT } }) },
    { name: "parent mismatch", handler: async () => ({ data: { id: CHILD, parentID: "ses_other" } }) },
    { name: "server rejection", handler: async () => ({ error: { message: "raw create secret" } }) },
    {
      name: "transport failure",
      handler: async () => {
        throw new Error("raw create throw")
      },
    },
  ]
  for (const item of cases) {
    const { client, calls } = fakeClient({ create: item.handler })
    const result = await createReviewChild(
      client,
      {
        parentID: PARENT,
        agent: { name: REVIEWER, model: REVIEWER_MODEL },
        permissions: [],
        attemptID: "attempt-1",
      },
      new AbortController().signal,
    )
    assert.equal(result.ok, false, item.name)
    if (result.ok) continue
    assert.equal(result.reason.includes("raw"), false, item.name)
    assert.equal(calls.length, 1, item.name)
  }
})

test("promptReviewChild sends the agent, model, variant and reserved prompt without format or tools", async () => {
  const controller = new AbortController()
  const { client, calls } = fakeClient({ promptAsync: async () => ({}) })
  const result = await promptReviewChild(
    client,
    {
      childID: CHILD,
      promptMessageID: PROMPT,
      agent: { name: REVIEWER, model: REVIEWER_MODEL, variant: "high" },
      text: "review payload",
    },
    controller.signal,
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value, null)
  const call = calls[0]
  assert.equal(call?.method, "promptAsync")
  assert.deepEqual(call?.options.path, { id: CHILD })
  assert.deepEqual(call?.options.body, {
    agent: REVIEWER,
    model: REVIEWER_MODEL,
    variant: "high",
    messageID: PROMPT,
    parts: [{ type: "text", text: "review payload" }],
  })
  assert.equal(call?.options.body.format, undefined)
  assert.equal(call?.options.body.tools, undefined)
  assert.equal(call?.options.signal, controller.signal)
})

test("promptReviewChild omits an absent variant and sanitises failures", async () => {
  const omitted = fakeClient({ promptAsync: async () => ({ response: { status: 204 } }) })
  const ok = await promptReviewChild(
    omitted.client,
    {
      childID: CHILD,
      promptMessageID: PROMPT,
      agent: { name: REVIEWER, model: REVIEWER_MODEL },
      text: "review payload",
    },
    new AbortController().signal,
  )
  assert.equal(ok.ok, true)
  assert.equal(omitted.calls[0]?.options.body.variant, undefined)

  const cases: Array<{ name: string; handler: FakeHandlers["promptAsync"] }> = [
    { name: "server rejection", handler: async () => ({ error: { message: "raw prompt secret" } }) },
    {
      name: "transport failure",
      handler: async () => {
        throw new Error("raw prompt throw")
      },
    },
  ]
  for (const item of cases) {
    const { client, calls } = fakeClient({ promptAsync: item.handler })
    const result = await promptReviewChild(
      client,
      {
        childID: CHILD,
        promptMessageID: PROMPT,
        agent: { name: REVIEWER, model: REVIEWER_MODEL },
        text: "review payload",
      },
      new AbortController().signal,
    )
    assert.equal(result.ok, false, item.name)
    if (result.ok) continue
    assert.equal(result.reason.includes("raw"), false, item.name)
    assert.equal(calls.length, 1, item.name)
  }
})

function completionTextPart(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "part_text", type: "text", text, ...extra }
}

function completionUser(id = PROMPT, sessionID = CHILD): Record<string, unknown> {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: REVIEWER,
      model: REVIEWER_MODEL,
    },
    parts: [completionTextPart("review request", { id: `${id}_text`, sessionID, messageID: id })],
  }
}

function completionAssistant(options: {
  id?: string
  parentID?: string
  sessionID?: string
  completed?: number | null
  error?: unknown
  summary?: unknown
  parts?: unknown[]
} = {}): Record<string, unknown> {
  const id = options.id ?? "msg_assistant"
  const sessionID = options.sessionID ?? CHILD
  const completed = options.completed === undefined ? 2 : options.completed
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: completed === null ? { created: 1 } : { created: 1, completed },
      parentID: options.parentID ?? PROMPT,
      modelID: REVIEWER_MODEL.modelID,
      providerID: REVIEWER_MODEL.providerID,
      mode: REVIEWER,
      ...(options.error === undefined ? {} : { error: options.error }),
      ...(options.summary === undefined ? {} : { summary: options.summary }),
    },
    parts: options.parts ?? [completionTextPart('{"decision":"keep"}')],
  }
}

function runCompletion(
  client: ReturnType<typeof fakeClient>["client"],
  signal: AbortSignal = new AbortController().signal,
) {
  return readReviewCompletion(client, CHILD, PROMPT, signal)
}

test("review completion is pending without a completed response", async () => {
  const empty = fakeClient({ messages: async () => ({ data: [] }) })
  assert.deepEqual(await runCompletion(empty.client), { ok: true, value: { status: "pending" } })

  const waiting = fakeClient({
    messages: async () => ({
      data: [
        completionUser(),
        completionAssistant({ completed: null, parts: [completionTextPart('{"decision":')] }),
      ],
    }),
  })
  assert.deepEqual(await runCompletion(waiting.client), { ok: true, value: { status: "pending" } })
})

test("review completion parses the whole visible text and ignores non-visible parts", async () => {
  const controller = new AbortController()
  const { client, calls } = fakeClient({
    messages: async () => ({
      data: [
        completionUser(),
        completionAssistant({
          parts: [
            { id: "part_start", type: "step-start" },
            completionTextPart("{", { id: "part_open" }),
            { id: "part_reason", type: "reasoning", text: '"reasoning":true,' },
            completionTextPart('"decision":"keep"}', { id: "part_close" }),
            completionTextPart("SYNTHETIC", { id: "part_synthetic", synthetic: true }),
            completionTextPart("IGNORED", { id: "part_ignored", ignored: true }),
            {
              id: "part_finish",
              type: "step-finish",
              reason: "stop",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          ],
        }),
      ],
    }),
  })
  const result = await runCompletion(client, controller.signal)
  assert.deepEqual(result, { ok: true, value: { status: "complete", structured: { decision: "keep" } } })
  assert.deepEqual(calls[0]?.options.path, { id: CHILD })
  assert.equal(calls[0]?.options.signal, controller.signal)
})

test("review completion rejects malformed visible JSON without extracting a text part", async () => {
  const { client } = fakeClient({
    messages: async () => ({
      data: [
        completionUser(),
        completionAssistant({
          parts: [
            completionTextPart('Here is the JSON: {"decision":"keep"}'),
            completionTextPart(" and some prose"),
          ],
        }),
      ],
    }),
  })
  assert.deepEqual(await runCompletion(client), {
    ok: true,
    value: { status: "error", reason: "invalid-json" },
  })
})

test("review completion rejects assistant errors, foreign prompts and foreign assistants", async () => {
  const cases: Array<{ name: string; messages: unknown[]; reason: string }> = [
    {
      name: "assistant error",
      messages: [
        completionUser(),
        completionAssistant({ error: { name: "UnknownError", data: { message: "raw provider" } } }),
      ],
      reason: "assistant-error",
    },
    {
      name: "foreign prompt",
      messages: [completionUser(), completionUser("msg_foreign"), completionAssistant()],
      reason: "foreign-prompt",
    },
    {
      name: "foreign assistant",
      messages: [
        completionUser(),
        completionAssistant({ id: "msg_foreign", parentID: "msg_other" }),
        completionAssistant(),
      ],
      reason: "foreign-message",
    },
  ]
  for (const item of cases) {
    const { client } = fakeClient({ messages: async () => ({ data: item.messages }) })
    assert.deepEqual(
      await runCompletion(client),
      { ok: true, value: { status: "error", reason: item.reason } },
      item.name,
    )
  }
})

test("review completion rejects completed tool-bearing and malformed responses", async () => {
  const toolBearing = fakeClient({
    messages: async () => ({
      data: [
        completionUser(),
        completionAssistant({
          parts: [
            completionTextPart('{"decision":"keep"}'),
            { id: "part_tool", type: "tool", tool: "bash", state: { status: "error" } },
          ],
        }),
      ],
    }),
  })
  assert.deepEqual(await runCompletion(toolBearing.client), {
    ok: true,
    value: { status: "error", reason: "tool-bearing" },
  })

  const malformed = fakeClient({
    messages: async () => ({
      data: [completionUser(), completionAssistant({ parts: [{ id: "part_bad", type: "text", text: 7 }] })],
    }),
  })
  assert.deepEqual(await runCompletion(malformed.client), {
    ok: true,
    value: { status: "error", reason: "malformed-completion" },
  })
})

test("review completion does not treat an incomplete tool step as completion", async () => {
  const { client } = fakeClient({
    messages: async () => ({
      data: [
        completionUser(),
        completionAssistant({
          completed: null,
          parts: [{ id: "part_tool", type: "tool", tool: "bash", state: { status: "running" } }],
        }),
      ],
    }),
  })
  assert.deepEqual(await runCompletion(client), { ok: true, value: { status: "pending" } })
})

test("review completion accepts compatible final duplicates and rejects incompatible ones", async () => {
  const compatible = fakeClient({
    messages: async () => ({
      data: [
        completionUser(),
        completionAssistant({ id: "msg_a" }),
        completionAssistant({ id: "msg_b" }),
      ],
    }),
  })
  assert.deepEqual(await runCompletion(compatible.client), {
    ok: true,
    value: { status: "complete", structured: { decision: "keep" } },
  })

  const incompatible = fakeClient({
    messages: async () => ({
      data: [
        completionUser(),
        completionAssistant({ id: "msg_a" }),
        completionAssistant({ id: "msg_b", parts: [completionTextPart('{"decision":"rename"}')] }),
      ],
    }),
  })
  assert.deepEqual(await runCompletion(incompatible.client), {
    ok: true,
    value: { status: "error", reason: "incompatible-results" },
  })
})

test("review completion sanitises read failures and malformed envelopes", async () => {
  const cases: Array<{ name: string; handler: FakeHandlers["messages"] }> = [
    { name: "server rejection", handler: async () => ({ error: { message: "raw read secret" } }) },
    { name: "missing data", handler: async () => ({}) },
    { name: "not an array", handler: async () => ({ data: { items: [] } }) },
    {
      name: "transport failure",
      handler: async () => {
        throw new Error("raw read throw")
      },
    },
  ]
  for (const item of cases) {
    const { client } = fakeClient({ messages: item.handler })
    const result = await runCompletion(client)
    assert.equal(result.ok, false, item.name)
    if (result.ok) continue
    assert.equal(result.reason.includes("raw"), false, item.name)
  }
})

test("stopReviewChild confirms only an accepted abort followed by idle status", async () => {
  const controller = new AbortController()
  const { client, calls } = fakeClient({
    abort: async () => ({ data: true }),
    status: async () => ({ data: { [CHILD]: { type: "idle" } } }),
  })
  const result = await stopReviewChild(client, CHILD, controller.signal)
  assert.deepEqual(result, { ok: true, value: { confirmed: true } })
  assert.deepEqual(calls.map((call) => call.method), ["abort", "status"])
  assert.deepEqual(calls[0]?.options.path, { id: CHILD })
  assert.equal(calls[0]?.options.signal, controller.signal)
  assert.equal(calls[1]?.options.signal, controller.signal)
})

test("stopReviewChild reports unconfirmed on abort rejection without reading status", async () => {
  const cases: Array<{ name: string; handler: FakeHandlers["abort"] }> = [
    { name: "server rejection", handler: async () => ({ error: { message: "raw abort secret" } }) },
    { name: "false acknowledgement", handler: async () => ({ data: false }) },
    { name: "missing acknowledgement", handler: async () => ({}) },
    {
      name: "transport failure",
      handler: async () => {
        throw new Error("raw abort throw")
      },
    },
  ]
  for (const item of cases) {
    const { client, calls } = fakeClient({ abort: item.handler })
    const result = await stopReviewChild(client, CHILD, new AbortController().signal)
    assert.deepEqual(result, { ok: true, value: { confirmed: false } }, item.name)
    assert.deepEqual(calls.map((call) => call.method), ["abort"], item.name)
  }
})

test("stopReviewChild reports unconfirmed when status is missing, unreadable or running", async () => {
  const cases: Array<{ name: string; handler: FakeHandlers["status"] }> = [
    { name: "missing entry", handler: async () => ({ data: {} }) },
    { name: "busy", handler: async () => ({ data: { [CHILD]: { type: "busy" } } }) },
    { name: "retry", handler: async () => ({ data: { [CHILD]: { type: "retry" } } }) },
    { name: "missing data", handler: async () => ({}) },
    { name: "not an object", handler: async () => ({ data: [] }) },
    { name: "server rejection", handler: async () => ({ error: { message: "raw status secret" } }) },
    {
      name: "transport failure",
      handler: async () => {
        throw new Error("raw status throw")
      },
    },
  ]
  for (const item of cases) {
    const { client } = fakeClient({
      abort: async () => ({ data: true }),
      status: item.handler,
    })
    const result = await stopReviewChild(client, CHILD, new AbortController().signal)
    assert.deepEqual(result, { ok: true, value: { confirmed: false } }, item.name)
  }
})
