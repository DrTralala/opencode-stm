// test/plugin.test.ts
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import pluginModule, { createStm, createTransform, createEventHook } from "../src/index.js"
import { DEFAULT_CONFIG } from "../src/config.js"
import { createOperationGuard, createStateStore, hashSessionID, hashTitle, initialMeta } from "../src/state.js"
import { lockManually } from "../src/scheduler.js"
import { createRootCache } from "../src/sdk.js"
import { createTranscriptQueue } from "../src/transcript.js"
import { createCurrentTools, type StmServices } from "../src/tools.js"
import type { MutableMessage } from "../src/injection.js"
import { fakeClient, type FakeHandler } from "./fakes.js"

const DEFAULT_TITLE = "New session - 2026-10-10T00:00:00.000Z"
const STM_SENTINEL = "STM_TRANSCRIPT_SENTINEL_9876"

const createdDirs: string[] = []

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
})

function track(dir: string): string {
  createdDirs.push(dir)
  return dir
}

function user(id: string): MutableMessage {
  return { info: { id, sessionID: "ses_1", role: "user" }, parts: [{ id: `${id}-p`, type: "text", text: `message ${id}` }] }
}

function makeServices(handlers: { get?: FakeHandler; update?: FakeHandler; messages?: FakeHandler } = {}) {
  const stateDir = track(mkdtempSync(join(tmpdir(), "stm-plugin-state-")))
  const { client } = fakeClient({
    get: handlers.get ?? (async (options: any) => ({ data: { id: options.path.id, title: DEFAULT_TITLE } })),
    update: handlers.update ?? (async (options: any) => ({ data: { id: options.path.id, title: options.body.title } })),
    messages: handlers.messages ?? (async () => ({ data: [], response: { headers: { get: () => null } } })),
  })
  const services: StmServices = {
    client,
    config: DEFAULT_CONFIG,
    state: createStateStore({ stateDir }),
    queue: createTranscriptQueue(),
    roots: createRootCache(client),
    guard: createOperationGuard(),
    blocked: new Map(),
    now: () => 0,
  }
  return { services, stateDir }
}

function readState(stateDir: string): any {
  const name = readdirSync(stateDir).find((entry) => entry.endsWith(".json"))
  assert.ok(name, "state file exists")
  return JSON.parse(readFileSync(join(stateDir, name), "utf8"))
}

function toolContext(messageID = "msg_tool"): any {
  return {
    sessionID: "ses_1",
    messageID,
    agent: "build",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  }
}

async function execute(tools: Record<string, any>, name: string, args: unknown, ctx: any) {
  return JSON.parse(String(await tools[name]!.execute(args, ctx)))
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function pendingReviewMeta(digest = hashTitle(DEFAULT_TITLE)) {
  return {
    ...initialMeta(),
    activity: 30,
    baselineMessageID: "m1",
    frontier: ["m1"],
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    anchors: [{ reviewID: "rev-1", reminderIndex: 0, anchorMessageID: "m1", partID: "stm-reminder-rev-1-0", obsolete: false }],
    titleDigest: digest,
  }
}

async function transcriptServices() {
  const { services, stateDir } = makeServices({
    messages: async () => ({
      data: [{ info: { id: "h1", sessionID: "ses_hist", role: "user" }, parts: [{ type: "text", text: STM_SENTINEL }] }],
      response: { headers: { get: () => null } },
    }),
  })
  const tools = (await import("../src/tools.js")).createHistoricalTools({
    ...services,
    config: { ...DEFAULT_CONFIG, historical: { readTitles: false, renameTitles: false, readTranscript: true } },
  })
  return { services, stateDir, tools }
}

test("default export is a PluginModule with the pinned id", () => {
  assert.equal(pluginModule.id, "opencode-stm")
  assert.equal(typeof pluginModule.server, "function")
})

test("invalid config disables every hook and emits a setting-scoped diagnostic", async () => {
  const configHome = track(mkdtempSync(join(tmpdir(), "stm-cfg-")))
  const configDir = join(configHome, "opencode", "opencode-stm")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, "config.yaml"), "review:\n  intervalMessages: 123456789\n")
  const errors: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => errors.push(args.join(" "))
  try {
    const hooks = await createStm({ client: fakeClient({}).client } as unknown as PluginInput, {
      env: { XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: track(mkdtempSync(join(tmpdir(), "stm-state-"))) },
      home: configHome,
    })
    assert.deepEqual(hooks.tool, {})
    assert.equal(hooks["experimental.chat.messages.transform"], undefined)
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /review\.intervalMessages/)
    assert.equal(errors[0]!.includes("123456789"), false)
  } finally {
    console.error = original
  }
})

test("transform baselines the first observation and injects a reminder at the threshold in place", async () => {
  const { services, stateDir } = makeServices()
  const transform = createTransform(services)
  const messages: MutableMessage[] = [user("m1")]
  await transform({}, { messages } as any)
  const baseline = readState(stateDir)
  assert.equal(baseline.activity, 0)
  assert.equal(baseline.titleDigest, hashTitle(DEFAULT_TITLE))

  const output = { get messages() { return messages } } as { messages: MutableMessage[] }
  for (let index = 2; index <= 21; index += 1) {
    messages.push(user(`m${index}`))
    await transform({}, output as any)
  }
  const state = readState(stateDir)
  assert.equal(state.activity, 20)
  assert.equal(state.review.remindersSent, 1)
  const reminder = messages[20]?.parts.find((part) => part.id?.startsWith("stm-reminder-"))
  assert.ok(reminder, "reminder part anchored to the 20th message")
  assert.match(String(reminder?.text), /ignore/i)

  // A repeated transform must not duplicate the part or advance activity.
  await transform({}, output as any)
  assert.equal(messages[20]?.parts.filter((part) => part.id?.startsWith("stm-reminder-")).length, 1)
  assert.equal(readState(stateDir).activity, 20)
})

test("transform never replaces output.messages and ignores child sessions", async () => {
  const { services } = makeServices()
  const transform = createTransform(services)
  const messages: MutableMessage[] = [user("m1")]
  const output: { messages: MutableMessage[] } = {} as any
  Object.defineProperty(output, "messages", {
    get: () => messages,
    set: () => {
      throw new Error("output.messages must not be replaced")
    },
  })
  await transform({}, output as any)
  assert.equal(messages.length, 1)

  const child = makeServices({ get: async (options: any) => ({ data: { id: options.path.id, title: DEFAULT_TITLE, parentID: "ses_parent" } }) })
  const childTransform = createTransform(child.services)
  const childMessages = [user("c1")]
  await childTransform({}, { messages: childMessages } as any)
  assert.equal(childMessages[0]?.parts.length, 1)
})

test("an external title change locks and stops further automatic injections", async () => {
  const title = { value: DEFAULT_TITLE }
  const { services, stateDir } = makeServices({ get: async (options: any) => ({ data: { id: options.path.id, title: title.value } }) })
  const transform = createTransform(services)
  const messages: MutableMessage[] = [user("m1")]
  // First observation baselines without counting; transform m1 alone so the
  // loop below adds exactly 20 eligible messages.
  await transform({}, { messages } as any)
  for (let index = 2; index <= 21; index += 1) {
    messages.push(user(`m${index}`))
    await transform({}, { messages } as any)
  }
  const opened = readState(stateDir)
  assert.equal(typeof opened.review?.id, "string")
  assert.equal(opened.locked, false)

  const reminderCount = messages
    .flatMap((message) => message.parts)
    .filter((part) => part.id?.startsWith("stm-reminder-")).length
  title.value = "Manually changed"
  for (let index = 22; index <= 61; index += 1) {
    messages.push(user(`m${index}`))
    await transform({}, { messages } as any)
  }
  const locked = readState(stateDir)
  assert.equal(locked.locked, true)
  assert.equal(locked.lockReason, "external")
  const after = messages
    .flatMap((message) => message.parts)
    .filter((part) => part.id?.startsWith("stm-reminder-")).length
  assert.equal(after, reminderCount)
})

test("non-default first titles lock immediately", async () => {
  const { services, stateDir } = makeServices({ get: async (options: any) => ({ data: { id: options.path.id, title: "Existing project" } }) })
  await createTransform(services)({}, { messages: [user("m1")] } as any)
  const state = readState(stateDir)
  assert.equal(state.locked, true)
  assert.equal(state.lockReason, "non-default-title")
})

test("a pending chunk is consumed by the next transform exactly once, even during a compaction-shaped request", async () => {
  const { services, stateDir, tools } = await transcriptServices()
  await tools.stm_history_transcript!.execute({ sessionID: "ses_hist" } as any, toolContext())

  const messages: MutableMessage[] = [
    user("m1"),
    { info: { id: "msg_tool", sessionID: "ses_1", role: "assistant" }, parts: [{ id: "tool-1", type: "tool", tool: "stm_history_transcript" }] },
    { info: { id: "summary-1", sessionID: "ses_1", role: "user", summary: { title: "s" } }, parts: [] },
  ]
  await createTransform(services)({}, { messages } as any)
  const injected = messages.flatMap((message) => message.parts).filter((part) => part.id?.startsWith("stm-transcript-"))
  assert.equal(injected.length, 1)
  assert.equal(JSON.stringify(readState(stateDir)).includes(STM_SENTINEL), false)

  await createTransform(services)({}, { messages } as any)
  assert.equal(
    messages.flatMap((message) => message.parts).filter((part) => part.id?.startsWith("stm-transcript-")).length,
    1,
  )
})

test("dispose releases queue and cache state", async () => {
  const hooks = await createStm(
    { client: fakeClient({ get: async (options: any) => ({ data: { id: options.path.id, title: DEFAULT_TITLE } }) }).client } as unknown as PluginInput,
    { env: { XDG_CONFIG_HOME: track(mkdtempSync(join(tmpdir(), "stm-cfg-"))), XDG_STATE_HOME: track(mkdtempSync(join(tmpdir(), "stm-state-"))) }, home: tmpdir() },
  )
  assert.equal(typeof hooks.dispose, "function")
  await hooks.dispose!()
})

test("tool definitions are stable for the instance lifetime", async () => {
  const configHome = track(mkdtempSync(join(tmpdir(), "stm-cfg-")))
  const configDir = join(configHome, "opencode", "opencode-stm")
  mkdirSync(configDir, { recursive: true })
  const configPath = join(configDir, "config.yaml")
  writeFileSync(configPath, "historical:\n  readTitles: true\n")
  const hooks = await createStm({ client: fakeClient({}).client } as unknown as PluginInput, {
    env: { XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: track(mkdtempSync(join(tmpdir(), "stm-state-"))) },
    home: configHome,
  })
  const before = Object.keys(hooks.tool ?? {}).sort()
  assert.deepEqual(before, ["stm_history_title_read", "stm_title_lock", "stm_title_read", "stm_title_review"])

  writeFileSync(configPath, "historical:\n  readTranscript: true\n")
  const after = Object.keys(hooks.tool ?? {}).sort()
  assert.deepEqual(after, before)
})

test("historical tools appear only for enabled flags", async () => {
  const configHome = track(mkdtempSync(join(tmpdir(), "stm-cfg-")))
  const configDir = join(configHome, "opencode", "opencode-stm")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, "config.yaml"), "historical:\n  readTranscript: true\n")
  const hooks = await createStm({ client: fakeClient({}).client } as unknown as PluginInput, {
    env: { XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: track(mkdtempSync(join(tmpdir(), "stm-state-"))) },
    home: configHome,
  })
  assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), [
    "stm_history_review_end",
    "stm_history_transcript",
    "stm_title_lock",
    "stm_title_read",
    "stm_title_review",
  ])
})

test("mixed-session transform is a no-op", async () => {
  const { services, stateDir } = makeServices()
  const messages: MutableMessage[] = [
    user("m1"),
    { info: { id: "o1", sessionID: "ses_2", role: "user" }, parts: [{ id: "o1-p", type: "text", text: "other" }] },
  ]
  const before = JSON.stringify(messages)
  await createTransform(services)({}, { messages } as any)
  assert.equal(JSON.stringify(messages), before)
  assert.equal(readdirSync(stateDir).some((entry) => entry.endsWith(".json")), false)
})

test("missing anchor releases the pending chunk without injection", async () => {
  const { services, tools } = await transcriptServices()
  await tools.stm_history_transcript!.execute({ sessionID: "ses_hist" } as any, toolContext("msg_gone"))

  const messages: MutableMessage[] = [user("m1")]
  await createTransform(services)({}, { messages } as any)
  assert.equal(messages.flatMap((message) => message.parts).filter((part) => part.id?.startsWith("stm-transcript-")).length, 0)

  // The chunk was consumed by the failed attempt; nothing is injected later.
  await createTransform(services)({}, { messages } as any)
  assert.equal(messages.flatMap((message) => message.parts).filter((part) => part.id?.startsWith("stm-transcript-")).length, 0)
})

test("session.deleted removes only the hashed state file", async () => {
  const { services, stateDir } = makeServices()
  await services.state.save("ses_1", initialMeta())
  await services.state.save("ses_2", initialMeta())
  services.blocked.set("ses_1", new Set(["ses_t"]))
  services.blocked.set("ses_other", new Set(["ses_1"]))

  const hook = createEventHook(services)
  await hook({ event: { type: "session.deleted", properties: { info: { id: "ses_1" } } } } as any)

  assert.equal(existsSync(join(stateDir, `${hashSessionID("ses_1")}.json`)), false)
  assert.equal(existsSync(join(stateDir, `${hashSessionID("ses_2")}.json`)), true)
  assert.equal(services.blocked.has("ses_1"), false)
  assert.equal(services.blocked.get("ses_other")?.size ?? 0, 0)
})

test("transform during a summary request rebaselines without counting", async () => {
  const { services, stateDir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 5,
    baselineMessageID: "m1",
    frontier: ["m1"],
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const messages: MutableMessage[] = [
    user("m1"),
    { info: { id: "s1", sessionID: "ses_1", role: "user", summary: { title: "s" } }, parts: [] },
    user("m2"),
  ]
  await createTransform(services)({}, { messages } as any)
  const state = readState(stateDir)
  assert.equal(state.activity, 5)
  assert.equal(state.baselineMessageID, "m2")
})

test("no transcript sentinel reaches state, tool result or reminder text", async () => {
  const { services, stateDir, tools } = await transcriptServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 20,
    baselineMessageID: "m1",
    frontier: ["m1"],
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 60 },
    anchors: [{ reviewID: "rev-1", reminderIndex: 0, anchorMessageID: "m1", partID: "stm-reminder-rev-1-0", obsolete: false }],
    titleDigest: hashTitle(DEFAULT_TITLE),
  })

  const result = String(await tools.stm_history_transcript!.execute({ sessionID: "ses_hist" } as any, toolContext()))
  assert.equal(result.includes(STM_SENTINEL), false)

  const messages: MutableMessage[] = [
    user("m1"),
    { info: { id: "msg_tool", sessionID: "ses_1", role: "assistant" }, parts: [{ id: "tool-1", type: "tool", tool: "stm_history_transcript" }] },
  ]
  await createTransform(services)({}, { messages } as any)
  assert.equal(JSON.stringify(readState(stateDir)).includes(STM_SENTINEL), false)

  const reminder = messages.flatMap((message) => message.parts).find((part) => part.id?.startsWith("stm-reminder-"))
  assert.ok(reminder, "reminder re-applied")
  assert.equal(String(reminder.text).includes(STM_SENTINEL), false)

  // The delivered chunk is the one sanctioned carrier of the transcript text.
  const chunk = messages.flatMap((message) => message.parts).find((part) => part.id?.startsWith("stm-transcript-"))
  assert.ok(chunk, "chunk delivered")
  assert.equal(String(chunk.text).includes(STM_SENTINEL), true)
})

test("a queued STM rename lands after the transform's guarded title check", async () => {
  const title = { value: DEFAULT_TITLE }
  const held = deferred()
  const release = deferred()
  let gets = 0
  const { services, stateDir } = makeServices({
    get: async (options: any) => {
      gets += 1
      if (gets === 2) {
        held.resolve()
        await release.promise
      }
      return { data: { id: options.path.id, title: title.value } }
    },
    update: async (options: any) => {
      title.value = String(options.body.title)
      return { data: { id: options.path.id, title: title.value } }
    },
  })
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 120,
    baselineMessageID: "m1",
    frontier: ["m1"],
    review: { id: "rev-1", remindersSent: 1, nextTriggerAt: 120 },
    anchors: [{ reviewID: "rev-1", reminderIndex: 0, anchorMessageID: "m1", partID: "stm-reminder-rev-1-0", obsolete: false }],
    titleDigest: hashTitle(DEFAULT_TITLE),
  })

  const messages: MutableMessage[] = [user("m1")]
  const transformPromise = createTransform(services)({}, { messages } as any)
  await held.promise
  const tools = createCurrentTools(services)
  const renamePromise = execute(
    tools,
    "stm_title_review",
    { decision: "rename", expectedTitle: DEFAULT_TITLE, title: "New name" },
    toolContext(),
  )
  await flush()
  release.resolve()
  await transformPromise
  const renameResult = await renamePromise

  // The rename's attributed transition wins: no spurious external lock, no
  // resurrected review, no stale digest.
  const state = readState(stateDir)
  assert.equal(renameResult.status, "ok")
  assert.equal(state.locked, false)
  assert.equal(state.lockReason, "none")
  assert.equal(state.review, null)
  assert.equal(state.titleDigest, hashTitle("New name"))
  assert.equal(messages.flatMap((m) => m.parts).filter((p) => p.id?.startsWith("stm-reminder-")).length, 2)
})

test("a manual rename between thresholds locks externally and suppresses reminder replay", async () => {
  const { services, stateDir } = makeServices({ get: async (options: any) => ({ data: { id: options.path.id, title: "Manually renamed" } }) })
  await services.state.save("ses_1", pendingReviewMeta())
  const messages: MutableMessage[] = [user("m1")]
  await createTransform(services)({}, { messages } as any)
  const state = readState(stateDir)
  assert.equal(state.locked, true)
  assert.equal(state.lockReason, "external")
  assert.equal(messages.flatMap((m) => m.parts).filter((p) => p.id?.startsWith("stm-reminder-")).length, 0)
})

test("a concurrent manual lock survives a transform that crosses the threshold", async () => {
  const { services, stateDir } = makeServices()
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 19,
    baselineMessageID: "m19",
    frontier: ["m1", "m19"],
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const originalLoad = services.state.load.bind(services.state)
  services.state.load = async (id: string) => {
    const loaded = await originalLoad(id)
    const concurrent = await originalLoad(id)
    if (concurrent.ok && concurrent.value !== null) await services.state.save(id, lockManually(concurrent.value))
    return loaded
  }
  const messages: MutableMessage[] = [user("m1"), user("m19"), user("m20")]
  await createTransform(services)({}, { messages } as any)
  const state = readState(stateDir)
  assert.equal(state.locked, true)
  assert.equal(state.lockReason, "manual")
  assert.equal(state.review, null)
  assert.equal(messages.flatMap((m) => m.parts).filter((p) => p.id?.startsWith("stm-reminder-")).length, 0)
})

test("resolved anchors replay without a title read", async () => {
  const { services, stateDir } = makeServices({
    get: async () => {
      throw new Error("unexpected title read")
    },
  })
  services.roots.remember("ses_1", true)
  await services.state.save("ses_1", {
    ...initialMeta(),
    activity: 0,
    baselineMessageID: "m1",
    frontier: ["m1"],
    anchors: [{ reviewID: "rev-1", reminderIndex: 0, anchorMessageID: "m1", partID: "stm-reminder-rev-1-0", obsolete: false }],
    titleDigest: hashTitle(DEFAULT_TITLE),
  })
  const messages: MutableMessage[] = [user("m1")]
  await createTransform(services)({}, { messages } as any)
  assert.equal(messages.flatMap((m) => m.parts).filter((p) => p.id?.startsWith("stm-reminder-")).length, 1)
  const state = readState(stateDir)
  assert.equal(state.locked, false)
})

test("a failed title read suppresses reminder replay fail-closed", async () => {
  const { services, stateDir } = makeServices({ get: async () => ({ error: { message: "unavailable" } }) })
  services.roots.remember("ses_1", true)
  await services.state.save("ses_1", pendingReviewMeta())
  const messages: MutableMessage[] = [user("m1")]
  await createTransform(services)({}, { messages } as any)
  assert.equal(messages.flatMap((m) => m.parts).filter((p) => p.id?.startsWith("stm-reminder-")).length, 0)
  const state = readState(stateDir)
  assert.equal(state.review?.id, "rev-1")
  assert.equal(state.locked, false)
})
