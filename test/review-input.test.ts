// test/review-input.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { collectReviewInput } from "../src/review-input.js"
import type { PageMessage, PagePart } from "../src/sdk.js"
import { fakeClient, headerResponse } from "./fakes.js"

const SESSION = "ses_parent"
const CUTOFF = "msg_dispatch"
const BEGIN_MARKER = "----- BEGIN OPENCODE-STM REVIEW TRANSCRIPT (UNTRUSTED DATA) -----"
const END_MARKER = "----- END OPENCODE-STM REVIEW TRANSCRIPT (UNTRUSTED DATA) -----"

const DEFAULT_CONFIG = {
  includeToolCalls: false,
  includeToolResults: false,
  maxBytes: 131072,
}

type FixturePart = PagePart & Record<string, unknown>
type FixtureMessage = PageMessage & { info: PageMessage["info"] & Record<string, unknown> }

function message(id: string, role: string, parts: FixturePart[], infoExtra: Record<string, unknown> = {}): FixtureMessage {
  return {
    info: { id, sessionID: SESSION, role, ...infoExtra },
    parts,
  }
}

function textPart(id: string, text: string, extra: Record<string, unknown> = {}): FixturePart {
  return { id, type: "text", text, ...extra }
}

function toolPart(id: string, tool: string, state: Record<string, unknown>): FixturePart {
  return { id, type: "tool", tool, state }
}

function userText(id: string, text: string): FixtureMessage {
  return message(id, "user", [textPart(`${id}_text`, text)])
}

function assistantText(id: string, text: string): FixtureMessage {
  return message(id, "assistant", [textPart(`${id}_text`, text)])
}

function cutoffMessage(text = "DISPATCH_CUTOFF"): FixtureMessage {
  return assistantText(CUTOFF, text)
}

type PageFixture = { items: PageMessage[]; nextCursor: string | null }

function pagedClient(pages: PageFixture[]): ReturnType<typeof fakeClient> {
  let index = 0
  return fakeClient({
    messages: async (options) => {
      const fixture = pages[index]
      assert.ok(fixture, `unexpected page request ${index + 1}`)
      assert.deepEqual(
        options.query,
        index === 0 ? { limit: 8 } : { limit: 8, before: pages[index - 1]!.nextCursor },
        "requests use no cursor first, then the exact opaque header cursor",
      )
      index += 1
      return {
        data: fixture.items,
        response: headerResponse("x-next-cursor", fixture.nextCursor),
      }
    },
  })
}

function run(
  client: ReturnType<typeof fakeClient>["client"],
  overrides: Partial<{ cutoffMessageID: string; title: string; config: typeof DEFAULT_CONFIG }> = {},
  signal: AbortSignal = new AbortController().signal,
) {
  return collectReviewInput(
    client,
    {
      sessionID: SESSION,
      cutoffMessageID: overrides.cutoffMessageID ?? CUTOFF,
      title: overrides.title ?? "Existing",
      config: overrides.config ?? DEFAULT_CONFIG,
    },
    signal,
  )
}

type DataRecord = {
  role: string
  messageID: string
  partID: string
  kind: string
  text?: string
  tool?: string
  input?: unknown
  output?: string
  error?: string
}

function bodyLines(text: string): string[] {
  const lines = text.split("\n")
  const begin = lines.indexOf(BEGIN_MARKER)
  const end = lines.indexOf(END_MARKER)
  assert.ok(begin >= 0, "prompt has a begin marker")
  assert.ok(end > begin, "prompt has an end marker after the begin marker")
  assert.equal(lines.filter((line) => line === BEGIN_MARKER).length, 1)
  assert.equal(lines.filter((line) => line === END_MARKER).length, 1)
  return lines.slice(begin + 1, end).filter((line) => line.length > 0)
}

function records(text: string): DataRecord[] {
  return bodyLines(text).map((line) => {
    assert.ok(line.startsWith("{"), "every transcript line is a complete JSON record")
    return JSON.parse(line) as DataRecord
  })
}

function texts(text: string): string[] {
  return records(text).filter((record) => record.kind === "text").map((record) => record.text ?? "")
}

test("review input keeps consecutive users but excludes reasoning and the cutoff", async () => {
  const fixture = (id: string, text: string): PageMessage => ({
    info: { id, sessionID: SESSION, role: "user" },
    parts: [
      { id: `${id}_text`, type: "text", text },
      { id: `${id}_reasoning`, type: "reasoning", text: "PRIVATE_REASONING" },
    ],
  })
  const { client } = pagedClient([
    {
      items: [fixture("msg_a", "FIRST_USER"), fixture("msg_b", "SECOND_USER"), cutoffMessage()],
      nextCursor: null,
    },
  ])
  const result = await run(client)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.match(result.value.text, /FIRST_USER/)
  assert.match(result.value.text, /SECOND_USER/)
  assert.doesNotMatch(result.value.text, /PRIVATE_REASONING/)
  assert.doesNotMatch(result.value.text, /DISPATCH_CUTOFF/)
  assert.equal(result.value.messageCount, 2)
})

test("review input traverses every older page after finding the cutoff", async () => {
  const { client, calls } = pagedClient([
    {
      items: [userText("msg_later_user", "LATER_USER"), assistantText("msg_later_assistant", "LATER_ASSISTANT")],
      nextCursor: "cursor_1",
    },
    {
      items: [userText("msg_before", "BEFORE_CUTOFF"), cutoffMessage()],
      nextCursor: "cursor_2",
    },
    {
      items: [
        assistantText("msg_old_assistant", "OLD_ASSISTANT"),
        userText("msg_old_user", "OLD_USER"),
      ],
      nextCursor: null,
    },
  ])
  const result = await run(client)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(texts(result.value.text), ["OLD_ASSISTANT", "OLD_USER", "BEFORE_CUTOFF"])
  assert.deepEqual(
    records(result.value.text).map((record) => record.role),
    ["assistant", "user", "user"],
    "consecutive same-role records are preserved rather than normalised",
  )
  assert.doesNotMatch(result.value.text, /LATER_USER|LATER_ASSISTANT|DISPATCH_CUTOFF/)
  assert.equal(result.value.messageCount, 3)
  assert.deepEqual(
    calls.map((call) => call.options.query),
    [{ limit: 8 }, { limit: 8, before: "cursor_1" }, { limit: 8, before: "cursor_2" }],
  )
})

test("review input keeps consecutive assistant records rather than inferring turns", async () => {
  const { client } = pagedClient([
    {
      items: [
        assistantText("msg_assistant_a", "ASSISTANT_A"),
        assistantText("msg_assistant_b", "ASSISTANT_B"),
        cutoffMessage(),
      ],
      nextCursor: null,
    },
  ])
  const result = await run(client)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(records(result.value.text).map((record) => [record.role, record.text]), [
    ["assistant", "ASSISTANT_A"],
    ["assistant", "ASSISTANT_B"],
  ])
  assert.equal(result.value.messageCount, 2)
})

test("review input fails closed when the cutoff boundary is missing", async () => {
  const { client } = pagedClient([
    { items: [userText("msg_a", "FIRST_USER"), userText("msg_b", "SECOND_USER")], nextCursor: null },
  ])
  const result = await run(client)
  assert.deepEqual(result, { ok: false, reason: "review-input-boundary-missing" })
})

test("review input rejects a cutoff with contradictory role attribution", async () => {
  const { client } = pagedClient([
    { items: [userText("msg_a", "FIRST_USER"), message(CUTOFF, "user", [textPart("p", "not assistant")])], nextCursor: null },
  ])
  const result = await run(client)
  assert.equal(result.ok, false)
})

test("review input rejects duplicate messages rather than deduplicating silently", async () => {
  const { client } = pagedClient([
    { items: [userText("msg_a", "ONCE"), cutoffMessage()], nextCursor: "cursor_1" },
    { items: [userText("msg_a", "TWICE")], nextCursor: null },
  ])
  const result = await run(client)
  assert.deepEqual(result, { ok: false, reason: "review-input-invalid" })
})

test("review input rejects repeated opaque cursors", async () => {
  const { client } = pagedClient([
    { items: [userText("msg_a", "NEWER")], nextCursor: "cursor_1" },
    { items: [cutoffMessage()], nextCursor: "cursor_1" },
  ])
  const result = await run(client)
  assert.deepEqual(result, { ok: false, reason: "review-input-invalid" })
})

test("review input rejects session and part attribution mismatches", async () => {
  const foreignSession = message("msg_foreign", "user", [textPart("part_foreign", "FOREIGN")])
  foreignSession.info.sessionID = "ses_other"
  const missingPartID = message("msg_missing_part", "user", [{ type: "text", text: "NO_PART_ID" }])
  const wrongPartMessage = message("msg_wrong_part", "user", [textPart("part_wrong", "WRONG", { messageID: "msg_other" })])
  const missingMessageID = message("", "user", [textPart("part_empty_message", "EMPTY_ID")])

  for (const invalid of [foreignSession, missingPartID, wrongPartMessage, missingMessageID]) {
    const { client } = pagedClient([{ items: [invalid, cutoffMessage()], nextCursor: null }])
    const result = await run(client)
    assert.deepEqual(result, { ok: false, reason: "review-input-invalid" }, invalid.info.id || "empty message id")
  }
})

test("review input fails closed on SDK page failure", async () => {
  const { client } = fakeClient({ messages: async () => ({ error: { message: "unavailable" } }) })
  const result = await run(client)
  assert.deepEqual(result, { ok: false, reason: "review-input-page-failed" })
})

test("review input reports an aborted fetch without reading further pages", async () => {
  const controller = new AbortController()
  let calls = 0
  const { client } = fakeClient({
    messages: async () => {
      calls += 1
      controller.abort()
      return { data: [userText("msg_a", "FIRST")], response: headerResponse("x-next-cursor", "cursor_1") }
    },
  })
  const result = await run(client, {}, controller.signal)
  assert.deepEqual(result, { ok: false, reason: "review-input-aborted" })
  assert.equal(calls, 1)
})

test("review input refuses to start after abort", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const { client } = fakeClient({
    messages: async () => {
      calls += 1
      return { data: [], response: headerResponse("x-next-cursor", null) }
    },
  })
  const result = await run(client, {}, controller.signal)
  assert.deepEqual(result, { ok: false, reason: "review-input-aborted" })
  assert.equal(calls, 0)
})

test("review input retains user summary text but excludes assistant summaries", async () => {
  const { client } = pagedClient([
    {
      items: [
        message("msg_user_summary", "user", [textPart("part_user_summary", "USER_SUMMARY_TEXT")], {
          summary: { title: "summary", body: "metadata" },
        }),
        message("msg_assistant_summary", "assistant", [textPart("part_summary_text", "COMPACTION_SUMMARY")], {
          summary: true,
        }),
        message("msg_assistant_summary_object", "assistant", [textPart("part_summary_object", "SUMMARY_OBJECT")], {
          summary: { title: "summary" },
        }),
        cutoffMessage(),
      ],
      nextCursor: null,
    },
  ])
  const result = await run(client)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(texts(result.value.text), ["USER_SUMMARY_TEXT"])
})

test("review input excludes synthetic, ignored, reasoning and file parts without reading them", async () => {
  const { client } = pagedClient([
    {
      items: [
        message("msg_visible", "assistant", [
          textPart("part_visible", "INTERRUPTED_VISIBLE"),
          textPart("part_synthetic", "SYNTHETIC_SECRET", { synthetic: true }),
          textPart("part_ignored", "IGNORED_SECRET", { ignored: true }),
          { id: "part_reasoning", type: "reasoning", text: "REASONING_SECRET" },
          { id: "part_file", type: "file", url: "https://example.invalid/BINARY_SECRET", mime: "image/png" },
        ], { error: { name: "MessageAbortedError", data: { message: "interrupted" } } }),
        cutoffMessage(),
      ],
      nextCursor: null,
    },
  ])
  const result = await run(client)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(texts(result.value.text), ["INTERRUPTED_VISIBLE"])
  assert.doesNotMatch(result.value.text, /SYNTHETIC_SECRET|IGNORED_SECRET|REASONING_SECRET|BINARY_SECRET/)
})

test("review input preserves whitespace and skips whitespace-only text", async () => {
  const { client } = pagedClient([
    {
      items: [
        message("msg_whitespace", "user", [
          textPart("part_whitespace", "  leading\n\n trailing  "),
          textPart("part_blank", " \n\t "),
        ]),
        cutoffMessage(),
      ],
      nextCursor: null,
    },
  ])
  const result = await run(client)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(texts(result.value.text), ["  leading\n\n trailing  "])
  assert.equal(result.value.messageCount, 1)
})

test("tool arguments and results are excluded by default", async () => {
  const tool = message("msg_tool", "assistant", [
    toolPart("part_tool", "bash", {
      status: "completed",
      input: { command: "echo ARGUMENT_SECRET" },
      output: "RESULT_SECRET",
      title: "bash",
      metadata: {},
      time: { start: 1, end: 2 },
    }),
  ])
  const { client } = pagedClient([{ items: [tool, cutoffMessage()], nextCursor: null }])
  const result = await run(client)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(texts(result.value.text), [])
  assert.equal(records(result.value.text).some((record) => record.kind.startsWith("tool-")), false)
  assert.doesNotMatch(result.value.text, /ARGUMENT_SECRET|RESULT_SECRET/)
})

test("tool arguments are included alone when only calls are enabled", async () => {
  const tool = message("msg_tool", "assistant", [
    toolPart("part_tool", "bash", {
      status: "completed",
      input: { command: "echo ARGUMENT_SECRET" },
      output: "RESULT_SECRET",
      title: "bash",
      metadata: {},
      time: { start: 1, end: 2 },
    }),
  ])
  const { client } = pagedClient([{ items: [tool, cutoffMessage()], nextCursor: null }])
  const result = await run(client, { config: { ...DEFAULT_CONFIG, includeToolCalls: true } })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const parsed = records(result.value.text)
  assert.deepEqual(parsed, [
    { role: "assistant", messageID: "msg_tool", partID: "part_tool", kind: "tool-call", tool: "bash", input: { command: "echo ARGUMENT_SECRET" } },
  ])
  assert.doesNotMatch(result.value.text, /RESULT_SECRET/)
})

test("tool results are included alone when only results are enabled", async () => {
  const tool = message("msg_tool", "assistant", [
    toolPart("part_tool", "bash", {
      status: "completed",
      input: { command: "echo ARGUMENT_SECRET" },
      output: "RESULT_SECRET",
      title: "bash",
      metadata: {},
      time: { start: 1, end: 2 },
    }),
  ])
  const { client } = pagedClient([{ items: [tool, cutoffMessage()], nextCursor: null }])
  const result = await run(client, { config: { ...DEFAULT_CONFIG, includeToolResults: true } })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(records(result.value.text), [
    { role: "assistant", messageID: "msg_tool", partID: "part_tool", kind: "tool-result", tool: "bash", output: "RESULT_SECRET" },
  ])
  assert.doesNotMatch(result.value.text, /ARGUMENT_SECRET/)
})

test("tool calls and results are both labelled when both opt-ins are enabled", async () => {
  const tool = message("msg_tool", "assistant", [
    toolPart("part_tool", "bash", {
      status: "completed",
      input: { command: "echo ARGUMENT_SECRET" },
      output: "RESULT_SECRET",
      title: "bash",
      metadata: {},
      time: { start: 1, end: 2 },
    }),
  ])
  const { client } = pagedClient([{ items: [tool, cutoffMessage()], nextCursor: null }])
  const result = await run(client, { config: { ...DEFAULT_CONFIG, includeToolCalls: true, includeToolResults: true } })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(records(result.value.text), [
    { role: "assistant", messageID: "msg_tool", partID: "part_tool", kind: "tool-call", tool: "bash", input: { command: "echo ARGUMENT_SECRET" } },
    { role: "assistant", messageID: "msg_tool", partID: "part_tool", kind: "tool-result", tool: "bash", output: "RESULT_SECRET" },
  ])
})

test("missing tool output and attachments are not fetched or invented", async () => {
  const tool = message("msg_tool", "assistant", [
    toolPart("part_tool", "read", {
      status: "completed",
      input: { path: "secret.txt" },
      title: "read",
      metadata: { spill: "https://example.invalid/SPILL_SECRET" },
      attachments: [{ id: "att", type: "file", url: "https://example.invalid/ATTACHMENT_SECRET" }],
    }),
  ])
  const { client, calls } = pagedClient([{ items: [tool, cutoffMessage()], nextCursor: null }])
  const result = await run(client, { config: { ...DEFAULT_CONFIG, includeToolCalls: true, includeToolResults: true } })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(records(result.value.text), [
    { role: "assistant", messageID: "msg_tool", partID: "part_tool", kind: "tool-call", tool: "read", input: { path: "secret.txt" } },
  ])
  assert.doesNotMatch(result.value.text, /SPILL_SECRET|ATTACHMENT_SECRET/)
  assert.deepEqual(calls.map((call) => call.method), ["messages"])
})

test("tool error text is available only with result opt-in", async () => {
  const tool = message("msg_tool", "assistant", [
    toolPart("part_tool", "bash", {
      status: "error",
      input: { command: "false" },
      error: "TOOL_ERROR",
      time: { start: 1, end: 2 },
    }),
  ])
  const { client } = pagedClient([{ items: [tool, cutoffMessage()], nextCursor: null }])
  const result = await run(client, { config: { ...DEFAULT_CONFIG, includeToolResults: true } })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(records(result.value.text), [
    { role: "assistant", messageID: "msg_tool", partID: "part_tool", kind: "tool-result", tool: "bash", error: "TOOL_ERROR" },
  ])
})

test("the complete prompt accounts for framing, title and UTF-8 bytes", async () => {
  const title = "Existing \"quoted\"\n title"
  const { client } = pagedClient([
    { items: [userText("msg_unicode", "emoji 😀 and 漢字"), cutoffMessage()], nextCursor: null },
  ])
  const result = await run(client, { title })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.bytes, Buffer.byteLength(result.value.text, "utf8"))
  assert.ok(result.value.bytes > result.value.text.length, "UTF-8 bytes exceed UTF-16 code units")
  assert.match(result.value.text, /emoji 😀 and 漢字/)
  assert.ok(result.value.text.includes(JSON.stringify(title)), "title is JSON-encoded in the prompt")
  const body = records(result.value.text)
  assert.deepEqual(body.map((record) => record.messageID), ["msg_unicode"])
})

test("an input exactly at the byte limit succeeds and one byte less fails", async () => {
  const { client } = pagedClient([
    { items: [userText("msg_unicode", "😀".repeat(20)), cutoffMessage()], nextCursor: null },
  ])
  const first = await run(client)
  assert.equal(first.ok, true)
  if (!first.ok) return
  const exact = first.value.bytes

  const { client: exactClient } = pagedClient([
    { items: [userText("msg_unicode", "😀".repeat(20)), cutoffMessage()], nextCursor: null },
  ])
  const exactResult = await run(exactClient, { config: { ...DEFAULT_CONFIG, maxBytes: exact } })
  assert.equal(exactResult.ok, true)
  if (!exactResult.ok) return
  assert.equal(exactResult.value.bytes, exact)

  const { client: overClient } = pagedClient([
    { items: [userText("msg_unicode", "😀".repeat(20)), cutoffMessage()], nextCursor: null },
  ])
  const overResult = await run(overClient, { config: { ...DEFAULT_CONFIG, maxBytes: exact - 1 } })
  assert.deepEqual(overResult, { ok: false, reason: "review-input-too-large" })
})

test("an oversized first page fails without fetching unnecessary older pages", async () => {
  let calls = 0
  const { client } = fakeClient({
    messages: async () => {
      calls += 1
      return {
        data: [userText("msg_big", "X".repeat(5000)), cutoffMessage()],
        response: headerResponse("x-next-cursor", "cursor_1"),
      }
    },
  })
  const result = await run(client, { config: { ...DEFAULT_CONFIG, maxBytes: 4096 } })
  assert.deepEqual(result, { ok: false, reason: "review-input-too-large" })
  assert.equal(calls, 1)
})

test("the prompt gives strict JSON keep/rename instructions and frames the transcript as untrusted", async () => {
  const { client } = pagedClient([{ items: [userText("msg_a", "HELLO"), cutoffMessage()], nextCursor: null }])
  const result = await run(client, { title: "Existing title" })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.match(result.value.text, /Existing title/)
  assert.match(result.value.text, /"decision":"keep"/)
  assert.match(result.value.text, /"decision":"rename"/)
  assert.match(result.value.text, /JSON object/i)
  assert.match(result.value.text, /do not use tools/i)
  assert.match(result.value.text, /untrusted/i)
  assert.match(result.value.text, new RegExp(SESSION))
  assert.match(result.value.text, new RegExp(CUTOFF))
})
