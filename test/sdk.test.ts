// test/sdk.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { MESSAGE_PAGE_LIMIT, createRootCache, page, readSession, writeTitle } from "../src/sdk.js"
import { fakeClient, headerResponse } from "./fakes.js"

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
