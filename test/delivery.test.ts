// test/delivery.test.ts
// Direct transcript results are ordinary persisted tool results. These tests
// replay reconstructed outgoing requests built from stored results and prove
// STM's transform never rewrites or re-injects them.
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
import { createTranscriptPager } from "../src/transcript.js"
import { createHistoricalTools, type StmServices } from "../src/tools.js"
import type { MutableMessage, MutablePart } from "../src/injection.js"
import { fakeClient, headerResponse, type FakeHandler } from "./fakes.js"

const DEFAULT_TITLE = "New session - 2026-10-10T00:00:00.000Z"
const BEGIN_MARKER = "----- BEGIN OPENCODE-STM HISTORICAL TRANSCRIPT (UNTRUSTED) -----"
const END_MARKER = "----- END OPENCODE-STM HISTORICAL TRANSCRIPT (UNTRUSTED) -----"
const ESCAPED_BEGIN = "-----\\ BEGIN OPENCODE-STM HISTORICAL TRANSCRIPT (UNTRUSTED) -----"
const ESCAPED_END = "-----\\ END OPENCODE-STM HISTORICAL TRANSCRIPT (UNTRUSTED) -----"

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

function headerOf(output: string): Record<string, any> {
  const first = output.split("\n")[0]
  assert.ok(first !== undefined && first.length > 0, "output has a header line")
  return JSON.parse(first)
}

// Single-pass inverse of the documented escape: escape tokens first, then
// doubled backslashes.
function decodeEscaped(text: string): string {
  let decoded = ""
  let index = 0
  while (index < text.length) {
    if (text.startsWith(ESCAPED_BEGIN, index)) {
      decoded += BEGIN_MARKER
      index += ESCAPED_BEGIN.length
      continue
    }
    if (text.startsWith(ESCAPED_END, index)) {
      decoded += END_MARKER
      index += ESCAPED_END.length
      continue
    }
    const char = text[index]!
    if (char === "\\") {
      assert.equal(text[index + 1], "\\", "the escaped payload doubles every literal backslash")
      decoded += "\\"
      index += 2
      continue
    }
    decoded += char
    index += 1
  }
  return decoded
}

function framePayload(output: string): string {
  const lines = output.split("\n")
  const begin = lines.indexOf(BEGIN_MARKER)
  const end = lines.lastIndexOf(END_MARKER)
  assert.ok(begin >= 0 && end > begin, "output carries one well-formed frame")
  return decodeEscaped(lines.slice(begin + 5, end).join("\n"))
}

function transcriptPart(id: string, callID: string, output: string): MutablePart {
  return {
    id,
    type: "tool",
    tool: "stm_history_transcript",
    callID,
    state: { status: "completed", output },
  } as MutablePart
}

function requestWith(output1: string, output2: string): MutableMessage[] {
  return [
    user("m1"),
    { info: { id: "call-1-msg", sessionID: "ses_1", role: "assistant" }, parts: [transcriptPart("part-1", "call-1", output1)] },
    user("m2"),
    { info: { id: "call-2-msg", sessionID: "ses_1", role: "assistant" }, parts: [transcriptPart("part-2", "call-2", output2)] },
    user("m3"),
  ]
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
    transcripts: createTranscriptPager(),
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

async function transcriptServices(source: string) {
  const { services, stateDir } = makeServices({
    messages: async () => ({
      data: [{ info: { id: "h1", sessionID: "ses_hist", role: "user" }, parts: [{ type: "text", text: source }] }],
      response: headerResponse("x-next-cursor", null),
    }),
  })
  const tools = createHistoricalTools({
    ...services,
    config: { ...DEFAULT_CONFIG, historical: { readTitles: false, renameTitles: false, readTranscript: true } },
  })
  return { services, stateDir, tools }
}

async function fetchChunk(tools: Record<string, any>, cursor?: string): Promise<string> {
  const args = cursor === undefined ? { sessionID: "ses_hist" } : { sessionID: "ses_hist", cursor }
  return String(await tools.stm_history_transcript!.execute(args as any, toolContext()))
}

// Collect two direct outputs for the source: the first bounded slice and the
// continuation that exhausts the page.
async function collectTwo(tools: Record<string, any>, source: string): Promise<[string, string]> {
  const first = await fetchChunk(tools)
  const firstHeader = headerOf(first)
  assert.equal(firstHeader.complete, false, "the fixture needs at least two chunks")
  const second = await fetchChunk(tools, firstHeader.cursor ?? undefined)
  assert.equal(headerOf(second).complete, true)
  assert.equal(framePayload(first) + framePayload(second), source)
  assert.notEqual(framePayload(first), framePayload(second))
  return [first, second]
}

test("stored direct results survive cloned requests with an intervening message", async () => {
  const source = `head-${"a".repeat(20000)}-tail`
  const { services, stateDir, tools } = await transcriptServices(source)
  const [first, second] = await collectTwo(tools, source)

  // The host reconstructs a fresh outgoing request from stored parts: clone the
  // stored outputs into new message objects and run the transform over them.
  const messages = requestWith(first, second)
  const before = JSON.stringify(messages)
  await createTransform(services)({}, { messages } as any)

  const partOne = messages[1]!.parts[0]! as MutablePart & { state: { output: string } }
  const partTwo = messages[3]!.parts[0]! as MutablePart & { state: { output: string } }
  assert.equal(partOne.state.output, first, "the earlier result is byte-identical after the transform")
  assert.equal(partTwo.state.output, second, "the later result is byte-identical after the transform")
  assert.equal(JSON.stringify(messages), before, "the transform does not rewrite the stored array")

  // Both chunks remain available without any STM replay injection and contain
  // distinct source slices.
  assert.equal(framePayload(partOne.state.output) + framePayload(partTwo.state.output), source)
  assert.notEqual(framePayload(partOne.state.output), framePayload(partTwo.state.output))
  assert.equal(messages.flatMap((message) => message.parts).filter((part) => part.id?.startsWith("stm-transcript-")).length, 0)
  assert.equal(JSON.stringify(readState(stateDir)).includes(source.slice(0, 40)), false, "no raw text reaches state")
})

test("review end never modifies already stored direct results", async () => {
  const source = `head-${"b".repeat(20000)}-tail`
  const { services, tools } = await transcriptServices(source)
  const [first, second] = await collectTwo(tools, source)

  const reviewed = JSON.parse(
    String(
      await tools.stm_history_review_end!.execute(
        { sessionID: "ses_hist", outcome: "reviewed" },
        toolContext("msg_end"),
      ),
    ),
  )
  assert.equal(reviewed.status, "ok")
  assert.equal(services.transcripts.has("ses_1"), false, "the pagination binding is discarded")

  const messages = requestWith(first, second)
  await createTransform(services)({}, { messages } as any)
  assert.equal(String((messages[1]!.parts[0] as MutablePart & { state: { output: string } }).state.output), first)
  assert.equal(String((messages[3]!.parts[0] as MutablePart & { state: { output: string } }).state.output), second)
  assert.equal(framePayload(first) + framePayload(second), source)
})

test("a sensitive review end cannot retract stored direct results", async () => {
  const source = `head-${"c".repeat(20000)}-tail`
  const { services, tools } = await transcriptServices(source)
  const [first, second] = await collectTwo(tools, source)

  const ended = JSON.parse(
    String(
      await tools.stm_history_review_end!.execute(
        { sessionID: "ses_hist", outcome: "sensitive" },
        toolContext("msg_end"),
      ),
    ),
  )
  assert.equal(ended.status, "ok")

  const messages = requestWith(first, second)
  const before = JSON.stringify(messages)
  await createTransform(services)({}, { messages } as any)
  assert.equal(JSON.stringify(messages), before, "a sensitive end does not alter past results")
  assert.equal(framePayload(first) + framePayload(second), source)
})

test("the transform ignores unrelated stored tool results", async () => {
  const { services } = makeServices()
  const messages = requestWith("result one", "result two")
  const before = JSON.stringify(messages)
  await createTransform(services)({}, { messages } as any)
  assert.equal(JSON.stringify(messages), before)
})
