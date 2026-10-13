// test/delivery.test.ts
// Outbound-only transcript delivery: the queued chunk rides the matching
// completed stm_history_transcript tool result (function_call_output) instead
// of a synthetic assistant part. All fixture identifiers and text are invented.
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { createTransform } from "../src/index.js"
import { DEFAULT_CONFIG } from "../src/config.js"
import { createOperationGuard, createStateStore } from "../src/state.js"
import { createRootCache } from "../src/sdk.js"
import { createTranscriptQueue } from "../src/transcript.js"
import { createHistoricalTools, type StmServices } from "../src/tools.js"
import type { MutableMessage, MutablePart } from "../src/injection.js"
import { fakeClient, headerResponse, type FakeHandler } from "./fakes.js"

const DEFAULT_TITLE = "New session - 2026-10-10T00:00:00.000Z"
const STM_SENTINEL = "STM_TRANSCRIPT_SENTINEL_7777"
// Invented ack chunk ids for fixture tool results only; never a real session id.
const OLD_CHUNK_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

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

function ackOutput(ack: Record<string, unknown>): string {
  return JSON.stringify(ack)
}

function transcriptToolPart(ack: Record<string, unknown>, overrides: Record<string, unknown> = {}): MutablePart {
  return {
    id: "tool-transcript",
    type: "tool",
    tool: "stm_history_transcript",
    callID: "call-transcript-1",
    state: { status: "completed", output: ackOutput(ack), ...overrides },
  } as MutablePart
}

function makeServices(handlers: { get?: FakeHandler; update?: FakeHandler; messages?: FakeHandler } = {}) {
  const stateDir = track(mkdtempSync(join(tmpdir(), "stm-delivery-state-")))
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

async function transcriptServices() {
  const { services, stateDir } = makeServices({
    messages: async () => ({
      data: [{ info: { id: "h1", sessionID: "ses_hist", role: "user" }, parts: [{ type: "text", text: STM_SENTINEL }] }],
      response: { headers: { get: () => null } },
    }),
  })
  const tools = createHistoricalTools({
    ...services,
    config: { ...DEFAULT_CONFIG, historical: { readTitles: false, renameTitles: false, readTranscript: true } },
  })
  return { services, stateDir, tools }
}

// Queue a chunk and return the ack the tool returned to the model: the same
// JSON the outgoing array carries as the transcript tool result.
async function queueChunk(services: StmServices, tools: Record<string, any>, messageID = "msg_tool") {
  const ack = await execute(tools, "stm_history_transcript", { sessionID: "ses_hist" }, toolContext(messageID))
  assert.equal(ack.status, "ok")
  assert.equal(typeof ack.chunkID, "string")
  return ack as Record<string, unknown>
}

test("transcript delivery relocates the queued chunk into the matching completed tool result", async () => {
  const { services, stateDir, tools } = await transcriptServices()
  const ack = await queueChunk(services, tools)
  const toolPart = transcriptToolPart(ack)
  assert.equal(String((toolPart.state as { output?: unknown }).output).includes(STM_SENTINEL), false, "the ack never carries text")

  const messages: MutableMessage[] = [
    user("m1"),
    { info: { id: "msg_tool", sessionID: "ses_1", role: "assistant" }, parts: [toolPart] },
  ]
  await createTransform(services)({}, { messages } as any)

  const output = String((toolPart.state as { output?: unknown }).output)
  // The ack stays byte-identical at the head; the framed chunk is appended.
  assert.ok(output.startsWith(ackOutput(ack)), "the ack prefix is intact")
  assert.match(output, /BEGIN OPENCODE-STM HISTORICAL TRANSCRIPT \(UNTRUSTED\)/)
  assert.match(output, /STM_TRANSCRIPT_SENTINEL_7777/)
  assert.match(output, /END OPENCODE-STM HISTORICAL TRANSCRIPT \(UNTRUSTED\)/)
  assert.ok(output.includes("\n\n"), "the chunk is separated from the ack by a blank line")
  // No synthetic assistant transcript part exists: the tool result is the only carrier.
  assert.equal(messages.flatMap((message) => message.parts).filter((part) => part.id?.startsWith("stm-transcript-")).length, 0)
  // The canonical call id and part identity survive conversion-ready delivery.
  assert.equal(toolPart.callID, "call-transcript-1")
  assert.equal(messages[1]?.parts[0], toolPart)
  assert.equal(messages.length, 2)
  // Consumed exactly once; the stored state never sees the transcript text.
  assert.equal(services.queue.take("ses_1", 0), null)
  assert.equal(JSON.stringify(readState(stateDir)).includes(STM_SENTINEL), false)
})

test("delivery matches the ack chunk id and never misroutes across tool results", async () => {
  const { services, tools } = await transcriptServices()
  const ack = await queueChunk(services, tools)

  const oldAck = { ...ack, chunkID: OLD_CHUNK_ID }
  const bashPart: MutablePart = { id: "tool-bash", type: "tool", tool: "bash", callID: "call-bash-1", state: { status: "completed", output: "bash output" } }
  const oldPart = transcriptToolPart(oldAck)
  const currentPart = transcriptToolPart(ack)

  const messages: MutableMessage[] = [
    user("m1"),
    {
      info: { id: "msg_tool", sessionID: "ses_1", role: "assistant" },
      parts: [bashPart, oldPart, currentPart],
    },
  ]
  await createTransform(services)({}, { messages } as any)

  // Only the result whose ack carries the pending chunk id receives the frame.
  assert.equal(String((bashPart.state as { output?: unknown }).output), "bash output")
  assert.equal(String((oldPart.state as { output?: unknown }).output), ackOutput(oldAck))
  const currentOutput = String((currentPart.state as { output?: unknown }).output)
  assert.match(currentOutput, /STM_TRANSCRIPT_SENTINEL_7777/)
  assert.equal(services.queue.take("ses_1", 0), null, "delivered exactly once")
})

test("an unfinished or non-correlating tool result leaves the chunk queued", async () => {
  const { services, tools } = await transcriptServices()
  const ack = await queueChunk(services, tools)

  // An unfinished result must not receive the frame and must not consume it.
  const runningPart = transcriptToolPart(ack, { status: "running", output: null })
  let messages: MutableMessage[] = [
    user("m1"),
    { info: { id: "msg_tool", sessionID: "ses_1", role: "assistant" }, parts: [runningPart] },
  ]
  await createTransform(services)({}, { messages } as any)
  assert.equal(String((runningPart.state as { output?: unknown }).output), "null")
  assert.notEqual(services.queue.take("ses_1", 0), null, "the chunk is retained, not consumed")
  // take() above was only the retention probe; re-queue by consuming the probe result
  services.queue.endReview("ses_1", "ses_hist")

  // An ack output without the correlation id (for example truncated by a host)
  // also fails to match and retains the chunk.
  const ack2 = await queueChunk(services, tools)
  delete ack2.chunkID
  const noCorrelationPart = transcriptToolPart(ack2)
  messages = [
    user("m1"),
    { info: { id: "msg_tool", sessionID: "ses_1", role: "assistant" }, parts: [noCorrelationPart] },
  ]
  await createTransform(services)({}, { messages } as any)
  assert.equal(String((noCorrelationPart.state as { output?: unknown }).output), ackOutput(ack2))
  assert.notEqual(services.queue.take("ses_1", 0), null, "the chunk is still retained, not consumed")
  services.queue.endReview("ses_1", "ses_hist")
})

test("delivery appends after host-appended markers in the ack output", async () => {
  const { services, tools } = await transcriptServices()
  const ack = await queueChunk(services, tools)
  // A capturing host may append markers to the output string before the
  // transform runs; the chunk-id correlation must still match the result.
  const toolPart = transcriptToolPart(ack)
  const marked = `${ackOutput(ack)}\n[capture-marker] wrapped`
  ;(toolPart.state as { output?: unknown }).output = marked

  const messages: MutableMessage[] = [
    user("m1"),
    { info: { id: "msg_tool", sessionID: "ses_1", role: "assistant" }, parts: [toolPart] },
  ]
  await createTransform(services)({}, { messages } as any)

  const output = String((toolPart.state as { output?: unknown }).output)
  assert.ok(output.startsWith(marked), "the marked ack stays intact at the head")
  assert.match(output, /STM_TRANSCRIPT_SENTINEL_7777/)
  assert.equal(services.queue.take("ses_1", 0), null)

  // Idempotence behind a marker: a replayed transform appends no second frame.
  await createTransform(services)({}, { messages } as any)
  assert.equal(String((toolPart.state as { output?: unknown }).output), output)
})

test("a foreign-target ack carrying the chunk id in appended text does not misroute or consume", async () => {
  const { services, tools } = await transcriptServices()
  const ack = await queueChunk(services, tools)
  // A completed transcript result of a DIFFERENT target whose captured output
  // embeds the pending chunk id: only the parsed ack object may correlate.
  const foreignPart = transcriptToolPart({
    ...ack,
    sessionID: "ses_other",
    chunkID: OLD_CHUNK_ID,
  })
  ;(foreignPart.state as { output?: unknown }).output = `${String((foreignPart.state as { output?: unknown }).output)}\nCaptured echo of chunk ${String(ack.chunkID)} while reviewing another target`

  const messages: MutableMessage[] = [
    user("m1"),
    { info: { id: "msg_tool", sessionID: "ses_1", role: "assistant" }, parts: [foreignPart] },
  ]
  await createTransform(services)({}, { messages } as any)

  assert.equal(
    String((foreignPart.state as { output?: unknown }).output).includes(STM_SENTINEL),
    false,
    "the foreign-target result never receives the frame",
  )
  assert.notEqual(services.queue.take("ses_1", 0), null, "the chunk is retained, not consumed")
})

test("a malformed ack output does not consume the chunk", async () => {
  const { services, tools } = await transcriptServices()
  const ack = await queueChunk(services, tools)
  // The ack JSON is no longer the leading object: fail closed.
  const toolPart = transcriptToolPart(ack)
  ;(toolPart.state as { output?: unknown }).output = `host prefix ${ackOutput(ack)}`

  const messages: MutableMessage[] = [
    user("m1"),
    { info: { id: "msg_tool", sessionID: "ses_1", role: "assistant" }, parts: [toolPart] },
  ]
  await createTransform(services)({}, { messages } as any)

  assert.equal(String((toolPart.state as { output?: unknown }).output).includes(STM_SENTINEL), false)
  assert.notEqual(services.queue.take("ses_1", 0), null, "the chunk is retained, not consumed")
})

test("duplicate matching acks fail closed and retain the queue", async () => {
  const { services, tools } = await transcriptServices()
  const ack = await queueChunk(services, tools)
  // Two identical completed acks cannot be disambiguated: neither is written.
  const firstPart = transcriptToolPart(ack)
  const secondPart = transcriptToolPart(ack)

  const messages: MutableMessage[] = [
    user("m1"),
    { info: { id: "msg_tool", sessionID: "ses_1", role: "assistant" }, parts: [firstPart, secondPart] },
  ]
  await createTransform(services)({}, { messages } as any)

  assert.equal(String((firstPart.state as { output?: unknown }).output), ackOutput(ack))
  assert.equal(String((secondPart.state as { output?: unknown }).output), ackOutput(ack))
  assert.notEqual(services.queue.take("ses_1", 0), null, "the chunk is retained, not consumed")
})

test("a missing anchor message retains the pending chunk for a later transform", async () => {
  const { services, tools } = await transcriptServices()
  await queueChunk(services, tools, "msg_gone")

  const messages: MutableMessage[] = [user("m1")]
  await createTransform(services)({}, { messages } as any)
  assert.equal(messages.flatMap((message) => message.parts).filter((part) => part.id?.startsWith("stm-transcript-")).length, 0)
  // The failed attempt did not consume the chunk: it is retained.
  assert.notEqual(services.queue.take("ses_1", 0), null)
  services.queue.endReview("ses_1", "ses_hist")

  // A later review can still queue and deliver through a matching result.
  const { services: services2, tools: tools2 } = await transcriptServices()
  const ack = await queueChunk(services2, tools2, "msg_tool")
  const toolPart = transcriptToolPart(ack)
  const later: MutableMessage[] = [
    user("m1"),
    { info: { id: "msg_tool", sessionID: "ses_1", role: "assistant" }, parts: [toolPart] },
  ]
  await createTransform(services2)({}, { messages: later } as any)
  assert.match(String((toolPart.state as { output?: unknown }).output), /STM_TRANSCRIPT_SENTINEL_7777/)
})
