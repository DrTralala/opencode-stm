// Task-1 runtime feasibility harness for the background title reviewer.
//
// The host is a real `opencode serve` process with an isolated HOME/XDG/TMPDIR,
// a local OpenAI-compatible SSE provider and one generated local plugin. The
// plugin uses only the client injected by OpenCode; the test process uses a
// separate control client. No package installation is performed and no real
// credentials, user sessions or external providers are reachable.

import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const SDK_CLIENT_PATH = join(REPO_ROOT, "node_modules/@opencode-ai/sdk/dist/client.js")
const BASE_TMP = "/tmp/opencode"
const WAIT_TIMEOUT_MS = 30_000
const PROCESS_EXIT_TIMEOUT_MS = 5_000

const DISPATCH_MARKER = "STM_DISPATCH_PROBE"
const STRUCTURED_MARKER = "STM_STRUCTURED_PROBE"
const HOSTILE_MARKER = "STM_HOSTILE_PROBE"
const PLAIN_MARKER = "STM_PLAIN_PROBE"
const ASYNC_TEXT_MARKER = "STM_ASYNC_TEXT_PROBE"
const ASYNC_CREATE_MARKER = "STM_ASYNC_CREATE_PROBE"
const ASYNC_FETCH_MARKER = "STM_ASYNC_FETCH_PROBE"
const ASYNC_FOREIGN_MARKER = "STM_ASYNC_FOREIGN_PROBE"
const PARENT_TURN_MARKER = "STM_PARENT_TURN_PROBE"
const SCHEMA_READ_MARKER = "STM_SCHEMA_READ_PROBE"
const SCHEMA_CHILD_MARKER = "STM_SCHEMA_CHILD_PROBE"
const BACKGROUND_UNLOCK_MARKER = "STM_BACKGROUND_UNLOCK_PROBE"
const BACKGROUND_LOCK_MARKER = "STM_BACKGROUND_LOCK_PROBE"
const BACKGROUND_SEED_MARKER = "STM_BACKGROUND_SEED_PROBE"
const BACKGROUND_DISPATCH_MARKER = "STM_BACKGROUND_DISPATCH_PROBE"
const BACKGROUND_CONTINUE_MARKER = "STM_BACKGROUND_CONTINUE_PROBE"
const BACKGROUND_REVIEW_PROMPT = "OpenCode STM background title review."
const BACKGROUND_TOOL = "stm_title_review_start"
const BACKGROUND_UNLOCK_TOOL = "stm_title_lock"
export const REVIEWER_ONLY_SENTINEL = "STM_REVIEWER_ONLY_SENTINEL_7f3c"
const ASYNC_TEXT_PROMPT =
  'STM_ASYNC_TEXT_PROBE. Reply with exactly one JSON object and nothing else: {"decision":"keep"}'
const VALID_ASYNC_TEXT = '{"decision":"keep"}'
const PARENT_AGENT = "stm-probe-parent"
const REVIEWER_AGENT = "stm-probe-reviewer"
const REVIEWER_STRICT_AGENT = "stm-probe-reviewer-deny"
const REVIEWER_PERMISSIVE_AGENT = "stm-probe-reviewer-permissive"
const DISPATCH_TOOL = "stm_probe_dispatch"
const UNRELATED_TOOL = "stm_probe_unrelated"
const ASYNC_CREATE_TOOL = "stm_probe_async_create"
const ASYNC_FETCH_TOOL = "stm_probe_async_fetch"
const ASYNC_FOREIGN_TOOL = "stm_probe_async_foreign"
const SCHEMA_READ_TOOL = "stm_probe_schema_read"

export const REVIEWER_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["keep", "rename"] },
  },
  required: ["decision"],
  additionalProperties: false,
}

const { createOpencodeClient } = await import(pathToFileURL(SDK_CLIENT_PATH).href)

async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function pickLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(() => resolve()))
  return port
}

function resolveOpencodeBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  try {
    return execFileSync("which", ["opencode"], { encoding: "utf8" }).trim()
  } catch {
    return ""
  }
}

function base32(bytes) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  let value = 0
  let bits = 0
  let output = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
  return output
}

function newMessageID() {
  const time = Buffer.alloc(6)
  let now = Date.now()
  for (let index = 5; index >= 0; index -= 1) {
    time[index] = now % 256
    now = Math.floor(now / 256)
  }
  return `msg_${base32(Buffer.concat([time, randomBytes(10)])).slice(0, 26)}`
}

function cursorMessageID(header) {
  if (typeof header !== "string" || header.length === 0) return null
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"))
    return typeof decoded?.id === "string" ? decoded.id : null
  } catch {
    return null
  }
}

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .join("")
  }
  return ""
}

function lastUserText(messages) {
  for (let index = (messages ?? []).length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "user") return textOf(message.content)
  }
  return ""
}

function toolDefinitions(body) {
  return (body?.tools ?? []).map((entry) => entry?.function ?? entry).filter(Boolean)
}

function sseChunk(model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-stm-probe",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function writeSse(res, body, { text, toolCall, reasoning }) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  if (typeof reasoning === "string") {
    res.write(
      sseChunk(body.model ?? "mock", {
        role: "assistant",
        reasoning_content: reasoning,
      }),
    )
  }
  if (toolCall) {
    res.write(
      sseChunk(
        body.model ?? "mock",
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: `call_${toolCall.kind}_${randomUUID()}`,
              type: "function",
              function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
            },
          ],
        },
      ),
    )
    res.write(sseChunk(body.model ?? "mock", {}, "tool_calls"))
  } else {
    res.write(sseChunk(body.model ?? "mock", { role: "assistant", content: text }))
    res.write(sseChunk(body.model ?? "mock", {}, "stop"))
  }
  res.end("data: [DONE]\n\n")
}

function writeJson(res, body) {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

class ProviderMock {
  constructor(options) {
    this.options = options
    this.requests = []
    this.server = null
    this.port = null
    this.holdArmed = false
    this.holdReached = null
    this.pendingDecision = null
    this.structuredAttempts = 0
    this.asyncHeld = null
    this.asyncRelease = null
    this.asyncErrorServed = false
    this.holdReceipt = null
    this.reviewHeld = null
    this.reviewRelease = null
    this.backgroundDuplicateServed = false
    this.backgroundReviewID = null
    this.backgroundExpectedTitle = null
  }

  async start() {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" })
        res.end(`mock error: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    await new Promise((resolve, reject) => {
      this.server.once("error", reject)
      this.server.listen(0, "127.0.0.1", () => resolve())
    })
    this.port = this.server.address().port
  }

  async stop() {
    if (!this.server) return
    if (this.asyncRelease) {
      this.asyncRelease.resolve()
      this.asyncRelease = null
      this.asyncHeld = null
    }
    if (this.reviewRelease) {
      this.reviewRelease.resolve({ decision: "keep" })
      this.reviewRelease = null
      this.reviewHeld = null
    }
    const server = this.server
    this.server = null
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(() => resolve()))
  }

  async handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    let raw = ""
    for await (const chunk of req) raw += chunk

    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      writeJson(res, { object: "list", data: [{ id: "mock", object: "model" }] })
      return
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      res.writeHead(404).end()
      return
    }

    let body
    try {
      body = JSON.parse(raw || "{}")
    } catch {
      res.writeHead(400).end()
      return
    }

    const tools = toolDefinitions(body)
    const names = tools.map((tool) => tool.name)
    const structuredTool = tools.find((tool) => tool.name === "StructuredOutput") ?? null
    const marker = lastUserText(body.messages)
    const messages = body.messages ?? []
    let markerIndex = -1
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]?.role === "user" && textOf(messages[index].content).includes(marker)) {
        markerIndex = index
      }
    }
    const toolResultAfterMarker =
      markerIndex >= 0 &&
      messages.slice(markerIndex + 1).some((message) => message?.role === "tool")

    let kind = "text"
    if (structuredTool) kind = "structured"
    else if (marker.includes(HOSTILE_MARKER)) kind = "hostile"
    else if (marker.includes(DISPATCH_MARKER)) kind = "dispatch"
    else if (marker.includes(ASYNC_TEXT_MARKER)) kind = "async-text"
    else if (marker.includes(ASYNC_CREATE_MARKER)) kind = "async-create"
    else if (marker.includes(ASYNC_FETCH_MARKER)) kind = "async-fetch"
    else if (marker.includes(ASYNC_FOREIGN_MARKER)) kind = "async-foreign"
    else if (marker.includes(PARENT_TURN_MARKER)) kind = "parent-turn"
    else if (marker.includes(SCHEMA_READ_MARKER)) kind = "schema-read"
    else if (marker.includes(SCHEMA_CHILD_MARKER)) kind = "schema-child"
    else if (marker.includes(BACKGROUND_REVIEW_PROMPT)) kind = "review-child"
    else if (marker.includes(BACKGROUND_UNLOCK_MARKER)) kind = "background-unlock"
    else if (marker.includes(BACKGROUND_LOCK_MARKER)) kind = "background-lock"
    else if (marker.includes(BACKGROUND_DISPATCH_MARKER)) kind = "background-dispatch"
    else if (marker.includes(BACKGROUND_CONTINUE_MARKER)) kind = "background-continue"
    else if (marker.includes(BACKGROUND_SEED_MARKER)) kind = "background-seed"
    else if (marker.includes("Generate a title for this conversation")) kind = "title"

    const systemText = messages
      .filter((message) => message?.role === "system")
      .map((message) => textOf(message.content))
      .join("\n")
    const allText = messages.map((message) => textOf(message?.content)).join("\n")
    const receipt = {
      id: this.requests.length + 1,
      method: req.method,
      path: url.pathname,
      kind,
      model: body.model ?? null,
      requestVariant: body.variant ?? null,
      stream: body.stream === true,
      marker,
      toolNames: names,
      toolChoice: body.tool_choice ?? null,
      hasToolResult: toolResultAfterMarker,
      containsReviewReminder: /Title review \S+ is due/.test(allText),
      containsReviewFrame: allText.includes("BEGIN OPENCODE-STM REVIEW TRANSCRIPT"),
      containsContinueMarker: allText.includes(BACKGROUND_CONTINUE_MARKER),
      containsSeedMarker: allText.includes(BACKGROUND_SEED_MARKER),
      containsToolCallRecord: allText.includes('"kind":"tool-call"'),
      containsToolResultRecord: allText.includes('"kind":"tool-result"'),
      systemMentionsStructuredOutput: systemText.includes("StructuredOutput"),
      structuredTool: structuredTool
        ? {
            name: structuredTool.name,
            description: structuredTool.description ?? null,
            parameters: structuredTool.parameters ?? structuredTool.input_schema ?? null,
          }
        : null,
    }
    this.requests.push(receipt)
    if (this.debugDir) {
      try {
        appendFileSync(
          join(this.debugDir, "provider-requests.jsonl"),
          JSON.stringify({
            id: receipt.id,
            kind,
            hasToolResult: toolResultAfterMarker,
            marker: marker.slice(0, 500),
            response: receipt.response ?? null,
          }) + "\n",
        )
      } catch {}
    }

    if (kind === "background-unlock") {
      const encoded = /EXPECTED_TITLE_B64=([A-Za-z0-9+/=]+)/.exec(marker)?.[1] ?? null
      let expectedTitle = null
      if (encoded !== null) expectedTitle = Buffer.from(encoded, "base64").toString("utf8")
      if (!toolResultAfterMarker) {
        receipt.response = "background-unlock-tool-call"
        writeSse(res, body, {
          toolCall: {
            kind: "background-unlock",
            name: BACKGROUND_UNLOCK_TOOL,
            arguments: { locked: false, expectedTitle },
          },
        })
        return
      }
      receipt.response = "background-unlock-ack"
      writeSse(res, body, { text: "BACKGROUND_UNLOCK_ACK" })
      return
    }

    if (kind === "background-lock") {
      const encoded = /EXPECTED_TITLE_B64=([A-Za-z0-9+/=]+)/.exec(marker)?.[1] ?? null
      let expectedTitle = null
      if (encoded !== null) expectedTitle = Buffer.from(encoded, "base64").toString("utf8")
      if (!toolResultAfterMarker) {
        receipt.response = "background-lock-tool-call"
        writeSse(res, body, {
          toolCall: {
            kind: "background-lock",
            name: BACKGROUND_UNLOCK_TOOL,
            arguments: { locked: true, expectedTitle },
          },
        })
        return
      }
      receipt.response = "background-lock-ack"
      writeSse(res, body, { text: "BACKGROUND_LOCK_ACK" })
      return
    }

    if (kind === "background-seed") {
      receipt.response = "background-seed-text"
      writeSse(res, body, { text: "BACKGROUND_SEED_ACK" })
      return
    }

    if (kind === "background-continue") {
      receipt.childHeldAtRequest = this.reviewHeld !== null
      receipt.response = "background-continue-text"
      writeSse(res, body, { text: "PARENT_CONTINUES_WHILE_REVIEW_PENDING" })
      return
    }

    if (kind === "background-dispatch") {
      const reviewID = /Title review (\S+) is due/.exec(marker)?.[1] ?? null
      const encoded = /EXPECTED_TITLE_B64=([A-Za-z0-9+/=]+)/.exec(marker)?.[1] ?? null
      let expectedTitle = null
      if (encoded !== null) {
        try {
          expectedTitle = Buffer.from(encoded, "base64").toString("utf8")
        } catch {
          expectedTitle = null
        }
      }
      if (reviewID !== null) this.backgroundReviewID = reviewID
      if (expectedTitle !== null) this.backgroundExpectedTitle = expectedTitle
      const resolvedReviewID = reviewID ?? this.backgroundReviewID
      const resolvedTitle = expectedTitle ?? this.backgroundExpectedTitle
      receipt.reviewID = resolvedReviewID
      receipt.expectedTitle = resolvedTitle
      const duplicate = this.options.duplicateDispatch === true && toolResultAfterMarker && !this.backgroundDuplicateServed
      if (!toolResultAfterMarker || duplicate) {
        if (duplicate) this.backgroundDuplicateServed = true
        if (resolvedReviewID === null || resolvedTitle === null) {
          receipt.response = "background-dispatch-missing-arguments"
          writeSse(res, body, { text: "BACKGROUND_DISPATCH_ARGUMENTS_MISSING" })
          return
        }
        receipt.response = duplicate ? "background-dispatch-duplicate-call" : "background-dispatch-tool-call"
        writeSse(res, body, {
          toolCall: {
            kind: "background-dispatch",
            name: BACKGROUND_TOOL,
            arguments: { reviewID: resolvedReviewID, expectedTitle: resolvedTitle },
          },
        })
        return
      }
      receipt.response = "background-dispatch-ack"
      writeSse(res, body, { text: "BACKGROUND_DISPATCH_ACK" })
      return
    }

    if (kind === "review-child") {
      receipt.requestAgent = body.agent ?? null
      receipt.requestModel = body.model ?? null
      receipt.requestVariant = body.variant ?? null
      receipt.promptContainsContinueMarker = marker.includes(BACKGROUND_CONTINUE_MARKER)
      receipt.promptContainsSeedMarker = marker.includes(BACKGROUND_SEED_MARKER)
      receipt.promptHasToolCallRecords = marker.includes('"kind":"tool-call"')
      receipt.promptHasToolResultRecords = marker.includes('"kind":"tool-result"')
      receipt.response = "review-child-held"
      this.reviewHeld = receipt
      const release = {}
      release.promise = new Promise((resolve) => {
        release.resolve = resolve
      })
      this.reviewRelease = release
      const decision = await release.promise
      this.reviewRelease = null
      this.reviewHeld = null
      receipt.held = false
      receipt.heldReleased = true
      const invalid = this.options.invalidReviewerOutput === true
      const text = invalid
        ? 'Here is the JSON: {"decision":"keep"}'
        : typeof decision === "string"
          ? JSON.stringify({ decision })
          : JSON.stringify(decision)
      receipt.response = invalid ? "review-child-invalid" : "review-child-valid"
      writeSse(res, body, { reasoning: REVIEWER_ONLY_SENTINEL, text })
      return
    }

    if (kind === "async-text" && toolResultAfterMarker) {
      receipt.response = "async-text-followup"
      writeSse(res, body, { text: VALID_ASYNC_TEXT })
      return
    }

    if (kind === "async-text" && this.options.asyncTextError && this.asyncErrorServed) {
      receipt.response = "async-text-error"
      res.writeHead(400, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: { message: "synthetic async text failure", type: "invalid_request_error" },
        }),
      )
      return
    }

    if (kind === "async-text") {
      receipt.held = true
      this.asyncHeld = receipt
      const release = {}
      release.promise = new Promise((resolve) => {
        release.resolve = resolve
      })
      this.asyncRelease = release
      await release.promise
      receipt.held = false
      receipt.heldReleased = true
      this.asyncHeld = null
      this.asyncRelease = null
      if (this.options.asyncTextError) {
        this.asyncErrorServed = true
        receipt.response = "async-text-error"
        res.writeHead(400, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            error: { message: "synthetic async text failure", type: "invalid_request_error" },
          }),
        )
        return
      }
      if (this.options.asyncTextHostile) {
        receipt.response = "async-text-hostile"
        writeSse(res, body, {
          toolCall: {
            kind: "async-hostile",
            name: UNRELATED_TOOL,
            arguments: { value: "hostile" },
          },
        })
        return
      }
      receipt.response = this.options.malformedAsyncText
        ? "async-text-malformed"
        : "async-text-valid"
      writeSse(res, body, {
        text: this.options.malformedAsyncText
          ? 'Here is the JSON: {"decision":"keep"}'
          : VALID_ASYNC_TEXT,
      })
      return
    }

    let heldDecision
    if (kind === "structured" && this.holdArmed && !toolResultAfterMarker) {
      heldDecision = await this.holdStructuredRequest(receipt)
    }

    if (kind === "structured" && structuredTool && !toolResultAfterMarker) {
      const malformed = this.options.malformedStructured === true && this.structuredAttempts === 0
      this.structuredAttempts += 1
      const decision = malformed ? "not-a-valid-decision" : (heldDecision ?? "keep")
      receipt.response = malformed ? "structured-malformed" : "structured-valid"
      writeSse(res, body, {
        toolCall: {
          kind: "structured",
          name: structuredTool.name,
          arguments: { decision },
        },
      })
      return
    }

    if (kind === "hostile" && !toolResultAfterMarker) {
      receipt.response = "hostile-tool-call"
      writeSse(res, body, {
        toolCall: {
          kind: "hostile",
          name: UNRELATED_TOOL,
          arguments: { value: "hostile" },
        },
      })
      return
    }

    if (kind === "dispatch" && !toolResultAfterMarker) {
      receipt.response = "dispatch-tool-call"
      writeSse(res, body, {
        toolCall: { kind: "dispatch", name: DISPATCH_TOOL, arguments: {} },
      })
      return
    }

    if (kind === "async-create" && !toolResultAfterMarker) {
      receipt.response = "async-create-tool-call"
      writeSse(res, body, {
        toolCall: { kind: "async-create", name: ASYNC_CREATE_TOOL, arguments: {} },
      })
      return
    }

    if (kind === "async-fetch" && !toolResultAfterMarker) {
      receipt.response = "async-fetch-tool-call"
      writeSse(res, body, {
        toolCall: { kind: "async-fetch", name: ASYNC_FETCH_TOOL, arguments: {} },
      })
      return
    }

    if (kind === "async-foreign" && !toolResultAfterMarker) {
      receipt.response = "async-foreign-tool-call"
      writeSse(res, body, {
        toolCall: { kind: "async-foreign", name: ASYNC_FOREIGN_TOOL, arguments: {} },
      })
      return
    }

    if (kind === "schema-read" && !toolResultAfterMarker) {
      receipt.response = "schema-read-tool-call"
      writeSse(res, body, {
        toolCall: { kind: "schema-read", name: SCHEMA_READ_TOOL, arguments: {} },
      })
      return
    }

    if (kind === "parent-turn") {
      receipt.childHeldAtRequest = this.asyncHeld !== null
      receipt.response = "parent-turn-text"
      writeSse(res, body, { text: "STM_PARENT_TURN_COMPLETE" })
      return
    }

    receipt.response = "text"
    writeSse(res, body, {
      text: kind === "title" ? "STM Probe Title" : "STM_PROBE_FINAL",
    })
  }

  holdStructuredRequest(receipt) {
    const reached = this.holdReached
    this.holdArmed = false
    this.holdReached = null
    this.holdReceipt = receipt
    if (reached) reached.resolve(receipt)
    return new Promise((resolve) => {
      this.pendingDecision = {
        resolve: (decision) => {
          this.pendingDecision = null
          resolve(decision)
        },
      }
    })
  }
}

function pluginSource() {
  return `// generated Task-1 fixture plugin: no package imports, injected client only
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
const REVIEWER_AGENT = ${JSON.stringify(REVIEWER_AGENT)}
const REVIEWER_STRICT_AGENT = ${JSON.stringify(REVIEWER_STRICT_AGENT)}
const UNRELATED_TOOL = ${JSON.stringify(UNRELATED_TOOL)}
const REVIEWER_SCHEMA = ${JSON.stringify(REVIEWER_SCHEMA)}
const DISPATCH_MARKER = ${JSON.stringify(DISPATCH_MARKER)}
const STRUCTURED_MARKER = ${JSON.stringify(STRUCTURED_MARKER)}
const HOSTILE_MARKER = ${JSON.stringify(HOSTILE_MARKER)}
const ASYNC_TEXT_PROMPT = ${JSON.stringify(ASYNC_TEXT_PROMPT)}
const ASYNC_CREATE_TOOL = ${JSON.stringify(ASYNC_CREATE_TOOL)}
const ASYNC_FETCH_TOOL = ${JSON.stringify(ASYNC_FETCH_TOOL)}
const ASYNC_FOREIGN_TOOL = ${JSON.stringify(ASYNC_FOREIGN_TOOL)}
const SCHEMA_READ_TOOL = ${JSON.stringify(SCHEMA_READ_TOOL)}
const SCHEMA_READ_MARKER = ${JSON.stringify(SCHEMA_READ_MARKER)}
const SCHEMA_CHILD_MARKER = ${JSON.stringify(SCHEMA_CHILD_MARKER)}

let unrelatedExecuted = false
let parentWakeCount = 0
let activeParentID = null
let activeParentMessageIDs = new Set()
let asyncProbeState = null
let asyncObserver = null
const ASYNC_OBSERVER_FILE = "stm-async-observer-start.json"

function log(event) {
  try {
    appendFileSync(join(process.env.TMPDIR, "stm-task1-plugin.log"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\\n")
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function messages(client, sessionID, directory) {
  const result = await client.session.messages({
    path: { id: sessionID },
    query: { directory },
  })
  if (result.error !== undefined || !Array.isArray(result.data)) {
    log({
      event: "messages:error",
      sessionID,
      error: result.error ?? null,
      dataType: typeof result.data,
      resultKeys: Object.keys(result ?? {}),
    })
    throw new Error("messages read failed: " + JSON.stringify({ error: result.error ?? null, dataType: typeof result.data, keys: Object.keys(result ?? {}) }))
  }
  return result.data
}

function findToolPart(items, tool) {
  for (const item of items) {
    for (const part of item.parts ?? []) {
      if (part?.type === "tool" && part.tool === tool) return part
    }
  }
  return null
}

function base32(bytes) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  let value = 0
  let bits = 0
  let output = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
  return output
}

function newMessageID() {
  const time = Buffer.alloc(6)
  let now = Date.now()
  for (let index = 5; index >= 0; index -= 1) {
    time[index] = now % 256
    now = Math.floor(now / 256)
  }
  return "msg_" + base32(Buffer.concat([time, randomBytes(10)])).slice(0, 26)
}

function visibleTextOf(item) {
  let text = ""
  for (const part of item?.parts ?? []) {
    if (part?.type !== "text" || part.synthetic === true || part.ignored === true) continue
    if (typeof part.text === "string") text += part.text
  }
  return text
}

function parseDecisionText(text) {
  if (typeof text !== "string") return { ok: false, reason: "invalid-json" }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: "invalid-json" }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid-shape" }
  }
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || keys[0] !== "decision") {
    return { ok: false, reason: "invalid-shape" }
  }
  if (parsed.decision !== "keep" && parsed.decision !== "rename") {
    return { ok: false, reason: "invalid-shape" }
  }
  return { ok: true, value: { decision: parsed.decision } }
}

const ASYNC_SETTLE_MS = 400
const ASYNC_SNAPSHOT_FILE = "stm-async-completion.json"

async function trackAsyncCompletion(client, state, parentID) {
  const started = Date.now()
  let items = []
  let assistant = null
  while (Date.now() - started < 20000) {
    try {
      items = await messages(client, state.childID, state.directory)
    } catch {
      await sleep(100)
      continue
    }
    const assistants = items.filter(
      (item) => item?.info?.role === "assistant" && item.info.parentID === state.promptMessageID,
    )
    assistant = assistants.at(-1) ?? null
    if (assistant && typeof assistant.info.time?.completed === "number") break
    await sleep(100)
  }
  await sleep(ASYNC_SETTLE_MS)

  let parentMessages = []
  let parentReadError = null
  try {
    parentMessages = await messages(client, parentID, state.directory)
  } catch (error) {
    parentReadError = String(error)
  }
  const observer = asyncObserver
  if (observer) observer.active = false
  const observerEvents = observer ? observer.events.slice() : []
  const snapshot = {
    childID: state.childID,
    promptMessageID: state.promptMessageID,
    assistantID: assistant?.info?.id ?? null,
    assistantCompleted: typeof assistant?.info?.time?.completed === "number",
    assistantError: assistant?.info?.error ?? null,
    parentSessionID: parentID,
    parentMessageIDs: parentMessages.map((item) => item.info.id),
    parentMessageCount: parentMessages.length,
    parentReadError,
    observerStartAt: observer?.startAt ?? null,
    observerSeenAt: observer?.seenAt ?? null,
    observerEventCount: observerEvents.length,
    observerChildEventCount: observerEvents.filter((entry) => entry.isChild).length,
    observerExcludedParentEventCount: observerEvents.filter((entry) => entry.excluded).length,
    observerParentEventCount: observerEvents.filter(
      (entry) => entry.isParent && !entry.excluded,
    ).length,
    observerParentEvents: observerEvents.filter(
      (entry) => entry.isParent && !entry.excluded,
    ),
    observerEvents,
    settledAt: Date.now(),
  }
  appendFileSync(
    join(process.env.TMPDIR, ASYNC_SNAPSHOT_FILE),
    JSON.stringify(snapshot) + "\\n",
  )
}

export default {
  id: "stm-task1-host-fixture",
  async server(input) {
    log({ event: "plugin:init", inputDirectory: input?.directory ?? null, inputKeys: Object.keys(input ?? {}) })
    return {
      event: async ({ event }) => {
        if (asyncObserver?.active) {
          const now = Date.now()
          if (asyncObserver.startAt === null) {
            try {
              const control = JSON.parse(
                readFileSync(join(process.env.TMPDIR, ASYNC_OBSERVER_FILE), "utf8"),
              )
              if (typeof control.startAt === "number") asyncObserver.startAt = control.startAt
              if (Array.isArray(control.parentTurnMessageIDs)) {
                asyncObserver.ignoreMessageIDs = new Set(control.parentTurnMessageIDs)
              }
            } catch {}
          }
          if (asyncObserver.startAt !== null && now >= asyncObserver.startAt) {
            const properties = event?.properties ?? {}
            const info = properties.info
            const part = properties.part
            const sessionID =
              properties.sessionID ??
              info?.sessionID ??
              part?.sessionID ??
              (event?.type?.startsWith("session.") ? info?.id : null) ??
              null
            const messageID = info?.id ?? part?.messageID ?? null
            const isParent = sessionID === asyncObserver.parentID
            if (asyncObserver.seenAt === null) asyncObserver.seenAt = now
            if (asyncObserver.events.length < 500) {
              asyncObserver.events.push({
                at: now,
                type: event?.type ?? "unknown",
                sessionID,
                isParent,
                isChild: sessionID === asyncObserver.childID,
                messageID,
                role: info?.role ?? null,
                status: properties.status?.type ?? null,
                excluded:
                  isParent &&
                  messageID !== null &&
                  asyncObserver.ignoreMessageIDs.has(messageID),
              })
            }
          }
        }

        if (activeParentID === null) return
        const info = event?.properties?.info
        if (
          event?.type === "message.updated" &&
          info?.sessionID === activeParentID &&
          typeof info.id === "string" &&
          !activeParentMessageIDs.has(info.id)
        ) {
          activeParentMessageIDs.add(info.id)
          parentWakeCount += 1
        }
      },
      tool: {
        [UNRELATED_TOOL]: {
          description: "Task-1 hostile-tool sentinel. Must never execute for the reviewer agent.",
          args: {},
          async execute() {
            unrelatedExecuted = true
            return "UNRELATED_TOOL_EXECUTED"
          },
        },
        [ASYNC_CREATE_TOOL]: {
          description: "Task-1 amended probe: raw child, promptAsync acknowledgement, no format or tool allow.",
          args: {},
          async execute(_args, context) {
            unrelatedExecuted = false
            const parentID = context.sessionID
            const directory = input.directory
            const created = await input.client.session.create({
              body: {
                parentID,
                title: "stm task1 async text child",
                permission: [{ permission: "*", pattern: "*", action: "deny" }],
              },
              query: { directory },
            })
            if (created.error !== undefined || !created.data?.id) {
              throw new Error("async session.create failed: " + JSON.stringify(created.error ?? null))
            }
            const childID = created.data.id
            asyncObserver = {
              parentID,
              childID,
              startAt: null,
              seenAt: null,
              active: true,
              ignoreMessageIDs: new Set(),
              events: [],
            }
            const promptMessageID = newMessageID()
            const ack = await input.client.session.promptAsync({
              path: { id: childID },
              query: { directory },
              body: {
                agent: REVIEWER_STRICT_AGENT,
                model: { providerID: "probe", modelID: "mock" },
                messageID: promptMessageID,
                parts: [{ type: "text", text: ASYNC_TEXT_PROMPT }],
              },
            })
            if (ack.error !== undefined) {
              throw new Error("async promptAsync failed: " + JSON.stringify(ack.error))
            }
            const ackStatus = ack.response?.status ?? null
            asyncProbeState = {
              childID,
              promptMessageID,
              directory,
              ackStatus,
              childPermission: created.data.permission ?? null,
            }
            trackAsyncCompletion(input.client, asyncProbeState, parentID).catch((error) => {
              log({ event: "async:track-error", error: String(error) })
            })
            log({ event: "async:create", childID, promptMessageID, ackStatus })
            return JSON.stringify({
              childID,
              promptMessageID,
              ackStatus,
              childPermission: created.data.permission ?? null,
              childDirectory: created.data.directory ?? null,
            })
          },
        },
        [ASYNC_FETCH_TOOL]: {
          description: "Task-1 amended probe: retrieve and strictly validate the completed async child reply.",
          args: {},
          async execute() {
            const state = asyncProbeState
            if (!state) throw new Error("no async probe state")
            const started = Date.now()
            let page = null
            let items = []
            let assistant = null
            while (Date.now() - started < 20000) {
              page = await input.client.session.messages({
                path: { id: state.childID },
                query: { directory: state.directory },
              })
              if (page.error !== undefined) break
              items = Array.isArray(page.data) ? page.data : []
              const assistants = items.filter(
                (item) => item?.info?.role === "assistant" && item.info.parentID === state.promptMessageID,
              )
              assistant = assistants.at(-1) ?? null
              if (assistant && typeof assistant.info.time?.completed === "number") break
              await sleep(100)
            }

            const base = {
              childID: state.childID,
              promptMessageID: state.promptMessageID,
              ackStatus: state.ackStatus,
              messagesReadStatus: page?.response?.status ?? null,
              messagesReadError: page?.error ?? null,
              childPermission: state.childPermission,
              messageCount: items.length,
            }
            if (page?.error !== undefined) {
              return JSON.stringify({
                ...base,
                structured: null,
                validationError: "messages-read-failed",
              })
            }

            const userItems = items.filter((item) => item?.info?.role === "user")
            const expectedUser = userItems.find((item) => item.info.id === state.promptMessageID) ?? null
            const foreignUsers = userItems.filter((item) => item.info.id !== state.promptMessageID)
            const foreignAssistants = items.filter(
              (item) => item?.info?.role === "assistant" && item.info.parentID !== state.promptMessageID,
            )
            const hostilePart = findToolPart(items, UNRELATED_TOOL)
            const expectedUserText = expectedUser ? visibleTextOf(expectedUser) : ""
            const promptTextMatches =
              expectedUser !== null && expectedUserText === ASYNC_TEXT_PROMPT
            const rawVisibleText = assistant ? visibleTextOf(assistant) : ""
            const parsed = parseDecisionText(rawVisibleText)

            let validationError = null
            if (!promptTextMatches) validationError = "foreign-prompt"
            else if (foreignUsers.length > 0 || foreignAssistants.length > 0)
              validationError = "foreign-prompt"
            else if (!assistant) validationError = "timeout"
            else if (assistant.info.error !== undefined) validationError = "assistant-error"
            else if (typeof assistant.info.time?.completed !== "number") validationError = "timeout"
            else if (!parsed.ok) validationError = parsed.reason

            return JSON.stringify({
              ...base,
              promptTextMatches,
              expectedUserText,
              parentIDCorrelated: assistant?.info?.parentID === state.promptMessageID,
              assistantCompleted: typeof assistant?.info?.time?.completed === "number",
              assistantError: assistant?.info?.error ?? null,
              assistantAgent: assistant?.info?.agent ?? assistant?.info?.mode ?? null,
              assistantModelID: assistant?.info?.modelID ?? null,
              assistantProviderID: assistant?.info?.providerID ?? null,
              assistantMessageID: assistant?.info?.id ?? null,
              rawVisibleText,
              structured: validationError === null ? parsed.value : null,
              validationError,
              hostileToolCallObserved: hostilePart !== null,
              hostileToolPartStatus: hostilePart?.state?.status ?? null,
              unrelatedToolExecuted: unrelatedExecuted,
              foreignUserMessageCount: foreignUsers.length,
              foreignAssistantMessageCount: foreignAssistants.length,
            })
          },
        },
        [ASYNC_FOREIGN_TOOL]: {
          description: "Task-1 amended negative control: add a foreign child prompt through the injected client.",
          args: {},
          async execute() {
            const state = asyncProbeState
            if (!state) throw new Error("no async probe state")
            const foreignMessageID = newMessageID()
            const ack = await input.client.session.promptAsync({
              path: { id: state.childID },
              query: { directory: state.directory },
              body: {
                agent: REVIEWER_STRICT_AGENT,
                model: { providerID: "probe", modelID: "mock" },
                messageID: foreignMessageID,
                noReply: true,
                parts: [{ type: "text", text: "STM_FOREIGN_PROMPT" }],
              },
            })
            if (ack.error !== undefined) {
              throw new Error("foreign promptAsync failed: " + JSON.stringify(ack.error))
            }
            return JSON.stringify({
              childID: state.childID,
              foreignMessageID,
              ackStatus: ack.response?.status ?? null,
            })
          },
        },
        [SCHEMA_READ_TOOL]: {
          description: "Task-1 original-path evidence: JSON-schema prompt then SDK message retrieval.",
          args: {},
          async execute(_args, context) {
            const parentID = context.sessionID
            const directory = input.directory
            const created = await input.client.session.create({
              body: {
                parentID,
                title: "stm schema read child",
                permission: [{ permission: "*", pattern: "*", action: "deny" }],
              },
              query: { directory },
            })
            if (created.error !== undefined || !created.data?.id) {
              throw new Error("schema-read session.create failed: " + JSON.stringify(created.error ?? null))
            }
            const childID = created.data.id
            const promptMessageID = newMessageID()
            const prompted = await input.client.session.prompt({
              path: { id: childID },
              query: { directory },
              body: {
                agent: REVIEWER_AGENT,
                model: { providerID: "probe", modelID: "mock" },
                messageID: promptMessageID,
                format: { type: "json_schema", schema: REVIEWER_SCHEMA },
                parts: [{ type: "text", text: SCHEMA_CHILD_MARKER }],
              },
            })
            const read = await input.client.session.messages({
              path: { id: childID },
              query: { directory },
            })
            return JSON.stringify({
              childID,
              promptMessageID,
              childPermission: created.data.permission ?? null,
              promptStatus: prompted.response?.status ?? null,
              assistantError: prompted.data?.info?.error ?? null,
              assistantStructured: prompted.data?.info?.structured ?? null,
              messagesReadStatus: read.response?.status ?? null,
              messagesReadError: read.error ?? null,
              messagesReadDataPresent: Array.isArray(read.data),
            })
          },
        },
        stm_probe_dispatch: {
          description: "Task-1 dispatch probe. Creates and prompts a restricted child through the injected client.",
          args: {},
          async execute(_args, context) {
            unrelatedExecuted = false
            const parentID = context.sessionID
            const directory = input.directory
            log({ event: "dispatch:start", parentID, directory, contextKeys: Object.keys(context ?? {}) })
            const parentBefore = await messages(input.client, parentID, directory)
            const parentMessageCountBefore = parentBefore.length
            const wakeBefore = parentWakeCount
            activeParentMessageIDs = new Set(parentBefore.map((item) => item.info.id))
            activeParentID = parentID

            const created = await input.client.session.create({
              body: { parentID, title: "stm task1 probe child" },
              query: { directory },
            })
            if (created.error !== undefined || !created.data?.id) {
              activeParentID = null
              throw new Error("injected client session.create failed")
            }
            const childID = created.data.id

            const hostilePrompt = await input.client.session.prompt({
              path: { id: childID },
              query: { directory },
              body: {
                agent: REVIEWER_AGENT,
                model: { providerID: "probe", modelID: "mock" },
                parts: [{ type: "text", text: HOSTILE_MARKER }],
              },
            })
            if (hostilePrompt.error !== undefined) {
              activeParentID = null
              throw new Error("injected client hostile prompt failed")
            }

            const hostileItems = await messages(input.client, childID, directory)
            const hostilePart = findToolPart(hostileItems, UNRELATED_TOOL)
            const hostileToolPartStatus = hostilePart?.state?.status ?? null
            const hostileToolCallObserved = hostilePart !== null

            const structuredMessageID = newMessageID()
            const structuredPrompt = await input.client.session.prompt({
              path: { id: childID },
              query: { directory },
              body: {
                agent: REVIEWER_AGENT,
                model: { providerID: "probe", modelID: "mock" },
                messageID: structuredMessageID,
                tools: { StructuredOutput: true },
                format: { type: "json_schema", schema: REVIEWER_SCHEMA },
                parts: [{ type: "text", text: STRUCTURED_MARKER }],
              },
            })
            if (structuredPrompt.error !== undefined) {
              activeParentID = null
              throw new Error("injected client structured prompt failed: " + JSON.stringify(structuredPrompt.error))
            }

            const assistant = structuredPrompt.data?.info ?? null
            const parentAfter = await messages(input.client, parentID, directory)
            const childAfter = await input.client.session.get({
              path: { id: childID },
              query: { directory },
            })
            activeParentID = null

            const transportVerified =
              created.error === undefined &&
              typeof childID === "string" &&
              childAfter.error === undefined &&
              childAfter.data?.id === childID

            // Runtime 1.19.4 accepts a StructuredOutput tool call without
            // validating its arguments against the advertised schema. The
            // caller must therefore validate the captured value itself.
            const hostStructured = assistant?.structured ?? null
            const validationError =
              hostStructured !== null &&
              typeof hostStructured === "object" &&
              !Array.isArray(hostStructured) &&
              Object.keys(hostStructured).length === 1 &&
              (hostStructured.decision === "keep" || hostStructured.decision === "rename")
                ? null
                : "invalid-structured-output"

            return JSON.stringify({
              structured: validationError === null ? hostStructured : null,
              hostStructured,
              validationError,
              selectedAgent: assistant?.agent ?? assistant?.mode ?? null,
              selectedMode: assistant?.mode ?? null,
              parentMessageCountBefore,
              parentMessageCountAfter: parentAfter.length,
              parentWakeCount: parentWakeCount - wakeBefore,
              unrelatedToolExecuted: unrelatedExecuted,
              injectedClientTransportVerified: transportVerified,
              directory,
              childDirectory: childAfter.data?.directory ?? created.data?.directory ?? null,
              childParentID: childAfter.data?.parentID ?? null,
              childAgent: childAfter.data?.agent ?? null,
              childModel: childAfter.data?.model ?? null,
              childPermission: childAfter.data?.permission ?? null,
              childVersion: childAfter.data?.version ?? null,
              assistantCwd: assistant?.path?.cwd ?? null,
              assistantRoot: assistant?.path?.root ?? null,
              promptParentIDCorrelated:
                typeof assistant?.parentID === "string" &&
                assistant.parentID === structuredMessageID,
              structuredMessageID,
              assistantCompleted: typeof assistant?.time?.completed === "number",
              assistantError: assistant?.error ?? null,
              assistantModelID: assistant?.modelID ?? null,
              assistantProviderID: assistant?.providerID ?? null,
              assistantVariant: assistant?.variant ?? null,
              assistantID: assistant?.id ?? null,
              hostileToolCallObserved,
              hostileToolPartStatus,
              childID,
            })
          },
        },
      },
    }
  },
}
`
}

class LoopbackHost {
  constructor(options = {}) {
    this.options = options
    this.serverPasswordEnabled = options.serverPassword !== false
    this.serverUsername = "stm-probe-user"
    this.serverPassword = this.serverPasswordEnabled ? `stm-${randomUUID()}` : null
    this.root = null
    this.directory = null
    this.serverCwd = null
    this.provider = new ProviderMock({
      malformedStructured: options.malformedStructured === true,
      malformedAsyncText: options.malformedAsyncText === true,
      asyncTextError: options.asyncTextError === true,
      asyncTextHostile: options.asyncTextHostile === true,
      invalidReviewerOutput: options.invalidReviewerOutput === true,
      duplicateDispatch: options.duplicateDispatch === true,
    })
    this.requests = this.provider.requests
    this.receipts = {}
    this.client = null
    this.child = null
    this.port = null
    this.stdout = ""
    this.stderr = ""
    this.cleaned = false
  }

  async start() {
    if (!existsSync(BASE_TMP)) throw new Error(`missing ${BASE_TMP}`)
    this.root = mkdtempSync(join(BASE_TMP, "stm-host-prereq-"))
    this.provider.debugDir = join(this.root, "tmp")
    for (const dir of ["home", "config/opencode", "data", "state", "cache", "tmp", "runtime"]) {
      mkdirSync(join(this.root, dir), { recursive: true })
    }
    this.serverCwd = join(this.root, "work")
    this.directory = join(this.serverCwd, "project")
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(join(this.directory, ".keep"), "isolated task-1 fixture\n")
    writeFileSync(
      join(this.root, "home/.npmrc"),
      [
        "registry=http://127.0.0.1:9/unreachable-registry",
        "fetch-retries=0",
        "fetch-timeout=1000",
        "",
      ].join("\n"),
    )
    // OpenCode's config loader calls Npm.install for every config directory.
    // Npm.install only skips reify when node_modules plus a matching package.json
    // and package-lock.json exist. Point node_modules at the already-installed
    // repository dependencies and stage matching metadata, so the loader neither
    // installs nor writes into the repository. The fixture plugin itself imports
    // only node: builtins; the test process imports the SDK by absolute path.
    const configDir = join(this.root, "config/opencode")
    const installedPlugin = JSON.parse(
      readFileSync(join(REPO_ROOT, "node_modules/@opencode-ai/plugin/package.json"), "utf8"),
    )
    mkdirSync(join(configDir, "node_modules"), { recursive: true })
    symlinkSync(
      join(REPO_ROOT, "node_modules/@opencode-ai"),
      join(configDir, "node_modules/@opencode-ai"),
      "dir",
    )
    const dependencies = { "@opencode-ai/plugin": installedPlugin.version }
    const packageJSON = { dependencies }
    const packageLock = {
      name: "stm-task1-isolated-config",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { dependencies } },
    }
    writeFileSync(join(configDir, "package.json"), JSON.stringify(packageJSON, null, 2))
    writeFileSync(join(configDir, "package-lock.json"), JSON.stringify(packageLock, null, 2))

    await this.provider.start()

    let pluginPath
    if (this.options.compiledPlugin === true) {
      pluginPath = join(REPO_ROOT, "dist/src/index.js")
      if (!existsSync(pluginPath)) throw new Error(`compiled plugin missing: ${pluginPath}`)
      const stmConfigDir = join(this.root, "config/opencode/opencode-stm")
      mkdirSync(stmConfigDir, { recursive: true })
      const includeToolCalls = this.options.includeToolCalls === true
      const includeToolResults = this.options.includeToolResults === true
      const reviewerAgent = this.options.reviewerAgent ?? REVIEWER_AGENT
      writeFileSync(
        join(stmConfigDir, "config.yaml"),
        [
          "review:",
          "  enabled: true",
          "  reviewer:",
          `    agent: ${JSON.stringify(reviewerAgent)}`,
          `    timeoutSeconds: ${this.options.reviewerTimeoutSeconds ?? 120}`,
          "    transcript:",
          `      includeToolCalls: ${includeToolCalls ? "true" : "false"}`,
          `      includeToolResults: ${includeToolResults ? "true" : "false"}`,
          "      maxBytes: 131072",
          "historical:",
          "  readTitles: false",
          "  renameTitles: false",
          "  readTranscript: false",
          "",
        ].join("\n"),
      )
    } else {
      pluginPath = join(this.root, "fixture-plugin.mjs")
      writeFileSync(pluginPath, pluginSource())
    }

    const config = {
      $schema: "https://opencode.ai/config.json",
      plugin: [pluginPath],
      model: "probe/mock",
      small_model: "probe/mock",
      default_agent: PARENT_AGENT,
      autoupdate: false,
      share: "disabled",
      snapshot: false,
      lsp: false,
      formatter: false,
      enabled_providers: ["probe"],
      provider: {
        probe: {
          options: {
            baseURL: `http://127.0.0.1:${this.provider.port}/v1`,
            apiKey: "probe-not-a-secret",
          },
          models: {
            mock: {
              name: "Mock",
              tool_call: true,
              limit: { context: 100000, output: 4096 },
            },
          },
        },
      },
      agent: {
        [PARENT_AGENT]: {
          description: "Task-1 harness parent agent.",
          mode: "primary",
          model: "probe/mock",
          permission: "allow",
        },
        [REVIEWER_AGENT]: {
          description: "Task-1 restricted structured reviewer.",
          mode: "subagent",
          model: "probe/mock",
          variant: "high",
          permission: {
            read: "allow",
            bash: "allow",
            edit: "allow",
            "*": "deny",
          },
        },
        [REVIEWER_STRICT_AGENT]: {
          description: "Task-1 amended strict reviewer with no allow rules.",
          mode: "subagent",
          model: "probe/mock",
          permission: "deny",
        },
        [REVIEWER_PERMISSIVE_AGENT]: {
          description: "Task-8 permissive reviewer used to test parent restrictions.",
          mode: "subagent",
          model: "probe/mock",
          variant: "high",
          permission: "allow",
        },
      },
    }
    const configPath = join(this.root, "config/opencode/opencode.json")
    writeFileSync(configPath, JSON.stringify(config, null, 2))

    const env = {
      PATH: "/usr/bin:/bin",
      HOME: join(this.root, "home"),
      XDG_CONFIG_HOME: join(this.root, "config"),
      XDG_DATA_HOME: join(this.root, "data"),
      XDG_STATE_HOME: join(this.root, "state"),
      XDG_CACHE_HOME: join(this.root, "cache"),
      XDG_RUNTIME_DIR: join(this.root, "runtime"),
      TMPDIR: join(this.root, "tmp"),
      LANG: "C.UTF-8",
      TERM: "dumb",
      OPENCODE_CONFIG: configPath,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/unreachable-registry",
      BUN_CONFIG_REGISTRY: "http://127.0.0.1:9/unreachable-registry",
      BUN_INSTALL_CACHE_DIR: join(this.root, "cache/bun"),
      npm_config_cache: join(this.root, "cache/npm"),
    }
    if (this.serverPasswordEnabled) {
      env.OPENCODE_SERVER_PASSWORD = this.serverPassword
      env.OPENCODE_SERVER_USERNAME = this.serverUsername
    }

    const opencodeBin = resolveOpencodeBin()
    if (!opencodeBin || !existsSync(opencodeBin)) {
      throw new Error("opencode binary not found")
    }
    this.port = await pickLoopbackPort()
    this.child = spawn(
      opencodeBin,
      ["serve", "--hostname", "127.0.0.1", "--port", String(this.port)],
      {
        cwd: this.serverCwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    this.child.stdout.setEncoding("utf8")
    this.child.stderr.setEncoding("utf8")
    this.child.stdout.on("data", (chunk) => {
      this.stdout += chunk
    })
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk
    })
    this.child.once("exit", (code, signal) => {
      this.exit = { code, signal }
    })

    const urlMatch = await this.waitForServerURL()
    this.port = Number(urlMatch)
    const headers = {}
    if (this.serverPasswordEnabled) {
      headers.authorization = `Basic ${Buffer.from(
        `${this.serverUsername}:${this.serverPassword}`,
      ).toString("base64")}`
    }
    this.client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${this.port}`,
      directory: this.directory,
      headers,
    })
    await this.waitForHealthy()
    const staged = readdirSync(join(configDir, "node_modules"))
    if (staged.length !== 1 || staged[0] !== "@opencode-ai") {
      throw new Error(
        `config dependency installer ran despite staged metadata: ${staged.join(", ")}`,
      )
    }
  }

  async waitForServerURL() {
    const started = Date.now()
    while (Date.now() - started < WAIT_TIMEOUT_MS) {
      if (this.exit) {
        throw new Error(`opencode exited before listening: ${this.safeLogs()}`)
      }
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(this.stdout)
      if (match) return match[1]
      await delay(25)
    }
    throw new Error(`opencode did not listen: ${this.safeLogs()}`)
  }

  async waitForHealthy() {
    const started = Date.now()
    while (Date.now() - started < WAIT_TIMEOUT_MS) {
      if (this.exit) throw new Error(`opencode exited during health check: ${this.safeLogs()}`)
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/session/status`, {
          headers: this.authHeaders(),
        })
        if (response.ok) return
        if (response.status === 401) throw new Error("control client authentication rejected")
      } catch (error) {
        if (error instanceof Error && error.message.includes("authentication")) throw error
      }
      await delay(50)
    }
    throw new Error(`opencode health check timed out: ${this.safeLogs()}`)
  }

  authHeaders() {
    if (!this.serverPasswordEnabled) return {}
    return {
      authorization: `Basic ${Buffer.from(
        `${this.serverUsername}:${this.serverPassword}`,
      ).toString("base64")}`,
    }
  }

  safeLogs() {
    let text = `${this.stdout}\n${this.stderr}`.trim()
    if (this.serverPassword) text = text.split(this.serverPassword).join("<redacted>")
    return text.slice(-4000) || "(no server output)"
  }

  async waitForRequest(predicate = () => true, timeoutMs = WAIT_TIMEOUT_MS) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const found = this.requests.find(predicate)
      if (found) return found
      await delay(25)
    }
    throw new Error("timed out waiting for provider request")
  }

  async waitForJsonFile(path, timeoutMs = WAIT_TIMEOUT_MS) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (existsSync(path)) {
        try {
          const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
          if (lines.length > 0) return JSON.parse(lines.at(-1))
        } catch {}
      }
      await delay(50)
    }
    throw new Error(`timed out waiting for completion snapshot: ${path}`)
  }

  async waitForIdle(sessionID, timeoutMs = WAIT_TIMEOUT_MS) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const status = await this.client.session.status({ query: { directory: this.directory } })
      if (status.error !== undefined) throw new Error("session status read failed")
      const current = status.data?.[sessionID]
      if (current === undefined || current.type === "idle") return
      if (current.type === "retry") await delay(Math.min(500, Math.max(50, current.next - Date.now())))
      else await delay(50)
    }
    throw new Error(`timed out waiting for idle session ${sessionID}`)
  }

  holdReviewer(timeoutMs = WAIT_TIMEOUT_MS) {
    if (this.provider.holdArmed || this.provider.holdReached) {
      throw new Error("a reviewer hold is already armed")
    }
    this.provider.holdArmed = true
    this.provider.holdReceipt = null
    const started = Date.now()
    return new Promise((resolve, reject) => {
      let timer
      const finish = (receipt) => {
        if (timer !== undefined) clearTimeout(timer)
        resolve(receipt)
      }
      const check = () => {
        if (this.provider.reviewHeld) return finish(this.provider.reviewHeld)
        if (this.provider.holdReceipt) {
          const receipt = this.provider.holdReceipt
          this.provider.holdReceipt = null
          return finish(receipt)
        }
        if (Date.now() - started >= timeoutMs) {
          this.provider.holdArmed = false
          this.provider.holdReached = null
          reject(new Error("timed out waiting for a reviewer request"))
          return
        }
        timer = setTimeout(check, 10)
        timer.unref?.()
      }
      check()
    })
  }

  releaseReviewer(decision) {
    if (this.provider.reviewRelease) {
      this.provider.reviewRelease.resolve(decision)
      return
    }
    if (!this.provider.pendingDecision) throw new Error("no held reviewer request")
    this.provider.pendingDecision.resolve(decision)
  }

  async createSession(title = "stm task1 probe") {
    const created = await this.client.session.create({
      body: { title },
      query: { directory: this.directory },
    })
    if (created.error !== undefined || !created.data?.id) {
      throw new Error("control client session.create failed")
    }
    return created.data
  }

  async fullMessages(sessionID) {
    const result = await this.client.session.messages({
      path: { id: sessionID },
      query: { directory: this.directory },
    })
    if (result.error !== undefined || !Array.isArray(result.data)) {
      throw new Error("control client message read failed")
    }
    return result.data
  }

  async page(sessionID, limit, before) {
    const query = { directory: this.directory, limit }
    if (before !== undefined) query.before = before
    const result = await this.client.session.messages({ path: { id: sessionID }, query })
    return {
      status: result.response?.status ?? null,
      error: result.error ?? null,
      items: Array.isArray(result.data) ? result.data : null,
      header: result.response?.headers?.get("x-next-cursor") ?? null,
    }
  }

  async probeRestrictedChild() {
    return withTimeout(
      this.runRestrictedChildProbe(),
      WAIT_TIMEOUT_MS * 2,
      "restricted child probe",
    )
  }

  async runRestrictedChildProbe() {
    const parent = await this.createSession("stm task1 parent")
    const prompted = await this.client.session.prompt({
      path: { id: parent.id },
      query: { directory: this.directory },
      body: {
        agent: PARENT_AGENT,
        model: { providerID: "probe", modelID: "mock" },
        parts: [{ type: "text", text: DISPATCH_MARKER }],
      },
    })
    if (prompted.error !== undefined) {
      throw new Error(`parent dispatch prompt failed: ${JSON.stringify(prompted.error)}`)
    }
    await this.waitForIdle(parent.id)
    const items = await this.fullMessages(parent.id)
    const toolPart = items
      .flatMap((item) => item.parts ?? [])
      .find((part) => part?.type === "tool" && part.tool === DISPATCH_TOOL)
    if (!toolPart) {
      throw new Error(`dispatch tool was not recorded; logs: ${this.safeLogs()}`)
    }
    if (toolPart.state?.status !== "completed") {
      throw new Error(
        `dispatch tool did not complete: ${JSON.stringify(toolPart.state)}; logs: ${this.safeLogs()}`,
      )
    }
    let receipts
    try {
      receipts = JSON.parse(toolPart.state.output)
    } catch {
      throw new Error("dispatch tool output was not JSON")
    }

    const hostileRequest = this.requests.find((request) => request.kind === "hostile")
    receipts.hostileToolOffered =
      hostileRequest?.toolNames?.includes(UNRELATED_TOOL) === true
    receipts.hostileRequestObserved = hostileRequest !== undefined
    receipts.serverPasswordEnabled = this.serverPasswordEnabled
    receipts.parentSessionID = parent.id
    receipts.providerRequestCount = this.requests.length
    return receipts
  }

  async readToolOutput(sessionID, tool) {
    const items = await this.fullMessages(sessionID)
    const part = items
      .flatMap((item) => item.parts ?? [])
      .find((entry) => entry?.type === "tool" && entry.tool === tool)
    if (!part) throw new Error(`${tool} was not recorded`)
    if (part.state?.status !== "completed") {
      throw new Error(`${tool} did not complete: ${JSON.stringify(part.state)}`)
    }
    try {
      return JSON.parse(part.state.output)
    } catch {
      throw new Error(`${tool} output was not JSON`)
    }
  }

  async readLastToolOutput(sessionID, tool) {
    const items = await this.fullMessages(sessionID)
    const parts = items
      .flatMap((item) => item.parts ?? [])
      .filter((entry) => entry?.type === "tool" && entry.tool === tool)
    const part = parts.at(-1) ?? null
    if (part === null) throw new Error(`${tool} was not recorded`)
    if (part.state?.status !== "completed") {
      throw new Error(`${tool} did not complete: ${JSON.stringify(part.state)}`)
    }
    try {
      return JSON.parse(part.state.output)
    } catch {
      throw new Error(`${tool} output was not JSON`)
    }
  }

  async probeAsyncTextChild() {
    return withTimeout(
      this.runAsyncTextChild(),
      WAIT_TIMEOUT_MS * 2,
      "async text child probe",
    )
  }

  async runAsyncTextChild() {
    const parent = await this.createSession("stm task1 async parent")
    const createPrompt = await this.client.session.prompt({
      path: { id: parent.id },
      query: { directory: this.directory },
      body: {
        agent: PARENT_AGENT,
        model: { providerID: "probe", modelID: "mock" },
        parts: [{ type: "text", text: ASYNC_CREATE_MARKER }],
      },
    })
    if (createPrompt.error !== undefined) {
      throw new Error(`async create prompt failed: ${JSON.stringify(createPrompt.error)}`)
    }
    const create = await this.readToolOutput(parent.id, ASYNC_CREATE_TOOL)

    const heldRequest = await this.waitForRequest(
      (request) => request.kind === "async-text" && request.held === true,
    )
    const heldStillBeforeParentTurn = this.provider.asyncHeld !== null

    const parentTurn = await this.client.session.prompt({
      path: { id: parent.id },
      query: { directory: this.directory },
      body: {
        agent: PARENT_AGENT,
        model: { providerID: "probe", modelID: "mock" },
        parts: [{ type: "text", text: PARENT_TURN_MARKER }],
      },
    })
    if (parentTurn.error !== undefined) {
      throw new Error(`parent turn failed: ${JSON.stringify(parentTurn.error)}`)
    }
    await this.waitForIdle(parent.id)
    await delay(100)
    const parentTurnMessageIDs = [
      parentTurn.data?.info?.id,
      parentTurn.data?.info?.parentID,
    ].filter((id) => typeof id === "string")
    const observerStartAt = Date.now()
    const observerControl = {
      startAt: observerStartAt,
      parentSessionID: parent.id,
      parentTurnMessageIDs,
    }
    writeFileSync(
      join(this.root, "tmp", "stm-async-observer-start.json"),
      JSON.stringify(observerControl),
    )
    const turnRequest = this.requests.find((request) => request.kind === "parent-turn")
    const automaticParentContinuation = this.requests.find(
      (request) => request.kind === "async-create" && request.hasToolResult === true,
    )
    const heldStillBeforeRelease = this.provider.asyncHeld !== null

    const parentBeforeRelease = await this.fullMessages(parent.id)
    const parentIDsBeforeRelease = parentBeforeRelease.map((item) => item.info.id)
    const requestIDsBeforeRelease = this.requests.map((request) => request.id)
    this.releaseAsyncChild()

    const completionSnapshot = await this.waitForJsonFile(
      join(this.root, "tmp", "stm-async-completion.json"),
    )
    const requestIDsAtCompletion = this.requests.map((request) => request.id)
    const newRequestIDsAfterRelease = requestIDsAtCompletion.filter(
      (id) => !requestIDsBeforeRelease.includes(id),
    )
    const newParentMessageIDs = completionSnapshot.parentMessageIDs.filter(
      (id) => !parentIDsBeforeRelease.includes(id),
    )
    const parentMessagesUnchanged =
      parentIDsBeforeRelease.length === completionSnapshot.parentMessageIDs.length &&
      parentIDsBeforeRelease.every(
        (id, index) => completionSnapshot.parentMessageIDs[index] === id,
      )

    const fetchPrompt = await this.client.session.prompt({
      path: { id: parent.id },
      query: { directory: this.directory },
      body: {
        agent: PARENT_AGENT,
        model: { providerID: "probe", modelID: "mock" },
        parts: [{ type: "text", text: ASYNC_FETCH_MARKER }],
      },
    })
    if (fetchPrompt.error !== undefined) {
      throw new Error(`async fetch prompt failed: ${JSON.stringify(fetchPrompt.error)}`)
    }
    const fetch = await this.readToolOutput(parent.id, ASYNC_FETCH_TOOL)
    const fetchRequests = this.requests.filter(
      (request) => !requestIDsAtCompletion.includes(request.id),
    )

    return {
      create,
      held: {
        requestId: heldRequest.id,
        toolNames: heldRequest.toolNames,
        systemMentionsStructuredOutput: heldRequest.systemMentionsStructuredOutput,
      },
      heldStillBeforeParentTurn,
      heldStillBeforeRelease,
      observerStart: observerControl,
      parentTurn: {
        requestId: turnRequest?.id ?? null,
        requestKind: turnRequest?.kind ?? null,
        childHeldAtRequest: turnRequest?.childHeldAtRequest ?? null,
        marker: turnRequest?.marker ?? null,
        assistantCompleted:
          typeof parentTurn.data?.info?.time?.completed === "number",
        assistantError: parentTurn.data?.info?.error ?? null,
      },
      automaticParentContinuation: {
        requestId: automaticParentContinuation?.id ?? null,
        requestKind: automaticParentContinuation?.kind ?? null,
        hasToolResult: automaticParentContinuation?.hasToolResult ?? null,
      },
      completion: {
        snapshot: completionSnapshot,
        parentMessageIDsBeforeRelease: parentIDsBeforeRelease,
        parentMessageIDsAtCompletion: completionSnapshot.parentMessageIDs,
        parentMessagesUnchanged,
        newParentMessageIDs,
        automaticParentWakeCount: newParentMessageIDs.length,
        providerRequestIDsBeforeRelease: requestIDsBeforeRelease,
        providerRequestIDsAtCompletion: requestIDsAtCompletion,
        newProviderRequestIDsAfterRelease: newRequestIDsAfterRelease,
        automaticParentProviderRequestCount: newRequestIDsAfterRelease.length,
      },
      fetch,
      fetchRequestIDs: fetchRequests.map((request) => request.id),
      fetchRequestKinds: fetchRequests.map((request) => request.kind),
      providerRequestCount: this.requests.length,
    }
  }

  releaseAsyncChild() {
    if (!this.provider.asyncRelease) throw new Error("no held async child request")
    this.provider.asyncRelease.resolve()
  }

  async probeAsyncForeignPrompt() {
    return withTimeout(
      this.runAsyncForeignPrompt(),
      WAIT_TIMEOUT_MS * 2,
      "async foreign prompt probe",
    )
  }

  async runAsyncForeignPrompt() {
    const parent = await this.createSession("stm task1 async foreign parent")
    const createPrompt = await this.client.session.prompt({
      path: { id: parent.id },
      query: { directory: this.directory },
      body: {
        agent: PARENT_AGENT,
        model: { providerID: "probe", modelID: "mock" },
        parts: [{ type: "text", text: ASYNC_CREATE_MARKER }],
      },
    })
    if (createPrompt.error !== undefined) {
      throw new Error(`async foreign create prompt failed: ${JSON.stringify(createPrompt.error)}`)
    }
    const create = await this.readToolOutput(parent.id, ASYNC_CREATE_TOOL)
    await this.waitForRequest(
      (request) => request.kind === "async-text" && request.held === true,
    )
    const heldStillBeforeForeign = this.provider.asyncHeld !== null

    const foreignPrompt = await this.client.session.prompt({
      path: { id: parent.id },
      query: { directory: this.directory },
      body: {
        agent: PARENT_AGENT,
        model: { providerID: "probe", modelID: "mock" },
        parts: [{ type: "text", text: ASYNC_FOREIGN_MARKER }],
      },
    })
    if (foreignPrompt.error !== undefined) {
      throw new Error(`foreign prompt failed: ${JSON.stringify(foreignPrompt.error)}`)
    }
    const foreign = await this.readToolOutput(parent.id, ASYNC_FOREIGN_TOOL)
    this.releaseAsyncChild()

    const fetchPrompt = await this.client.session.prompt({
      path: { id: parent.id },
      query: { directory: this.directory },
      body: {
        agent: PARENT_AGENT,
        model: { providerID: "probe", modelID: "mock" },
        parts: [{ type: "text", text: ASYNC_FETCH_MARKER }],
      },
    })
    if (fetchPrompt.error !== undefined) {
      throw new Error(`foreign fetch prompt failed: ${JSON.stringify(fetchPrompt.error)}`)
    }
    const fetch = await this.readToolOutput(parent.id, ASYNC_FETCH_TOOL)
    return { create, foreign, heldStillBeforeForeign, fetch }
  }

  async probeSchemaReadFailure() {
    return withTimeout(
      this.runSchemaReadFailure(),
      WAIT_TIMEOUT_MS * 2,
      "schema read failure probe",
    )
  }

  async runSchemaReadFailure() {
    const parent = await this.createSession("stm task1 schema read parent")
    const prompted = await this.client.session.prompt({
      path: { id: parent.id },
      query: { directory: this.directory },
      body: {
        agent: PARENT_AGENT,
        model: { providerID: "probe", modelID: "mock" },
        parts: [{ type: "text", text: SCHEMA_READ_MARKER }],
      },
    })
    if (prompted.error !== undefined) {
      throw new Error(`schema read prompt failed: ${JSON.stringify(prompted.error)}`)
    }
    return this.readToolOutput(parent.id, SCHEMA_READ_TOOL)
  }

  async collectPaginationAndIdFacts() {
    return withTimeout(
      this.runCollectPaginationAndIdFacts(),
      WAIT_TIMEOUT_MS * 2,
      "pagination and ID facts",
    )
  }

  async runCollectPaginationAndIdFacts() {
    const seed = await this.createSession("stm task1 pagination seed")
    const seedIDs = []
    for (let index = 0; index < 10; index += 1) {
      const messageID = newMessageID()
      const result = await this.client.session.prompt({
        path: { id: seed.id },
        query: { directory: this.directory },
        body: {
          agent: PARENT_AGENT,
          messageID,
          noReply: true,
          parts: [{ type: "text", text: `seed-${index}` }],
        },
      })
      if (result.error !== undefined || result.data?.info?.id !== messageID) {
        throw new Error(`seed ${index} was not accepted with an explicit message ID`)
      }
      seedIDs.push(messageID)
    }

    const full = await this.fullMessages(seed.id)
    const firstPage = await this.page(seed.id, 4)
    const secondPage = await this.page(seed.id, 4, firstPage.header)
    const thirdPage = await this.page(seed.id, 4, secondPage.header)

    const boundarySession = await this.createSession("stm task1 boundary")
    const boundarySeedIDs = []
    for (let index = 0; index < 3; index += 1) {
      const seeded = await this.client.session.prompt({
        path: { id: boundarySession.id },
        query: { directory: this.directory },
        body: {
          agent: PARENT_AGENT,
          noReply: true,
          parts: [{ type: "text", text: `boundary-seed-${index}` }],
        },
      })
      if (seeded.error !== undefined) throw new Error("boundary seed failed")
      boundarySeedIDs.push(seeded.data.info.id)
    }
    const dispatchMessageID = newMessageID()
    const dispatch = await this.client.session.prompt({
      path: { id: boundarySession.id },
      query: { directory: this.directory },
      body: {
        agent: PARENT_AGENT,
        messageID: dispatchMessageID,
        tools: { bash: false },
        parts: [{ type: "text", text: PLAIN_MARKER }],
      },
    })
    if (dispatch.error !== undefined) {
      throw new Error(`dispatch prompt failed: ${JSON.stringify(dispatch.error)}`)
    }
    const boundaryPage = await this.page(boundarySession.id, 2)
    const boundaryOlder = await this.page(boundarySession.id, 8, boundaryPage.header)
    const rawBefore = await this.page(boundarySession.id, 4, dispatchMessageID)
    const beforeWithoutLimit = await this.client.session.messages({
      path: { id: boundarySession.id },
      query: { directory: this.directory, before: dispatchMessageID },
    })
    const sessionRead = await this.client.session.get({
      path: { id: boundarySession.id },
      query: { directory: this.directory },
    })
    if (sessionRead.error !== undefined) throw new Error("session read failed")

    const assistant = dispatch.data?.info ?? null
    return {
      seedCount: seedIDs.length,
      seedIDs,
      full,
      firstPage: {
        status: firstPage.status,
        ids: firstPage.items?.map((item) => item.info.id) ?? [],
        header: firstPage.header,
        headerMessageID: cursorMessageID(firstPage.header),
      },
      secondPage: {
        ids: secondPage.items?.map((item) => item.info.id) ?? [],
        header: secondPage.header,
        headerMessageID: cursorMessageID(secondPage.header),
      },
      thirdPage: {
        ids: thirdPage.items?.map((item) => item.info.id) ?? [],
        header: thirdPage.header,
        headerMessageID: cursorMessageID(thirdPage.header),
      },
      terminalCursor: thirdPage.header,
      boundary: {
        pageIDs: boundaryPage.items?.map((item) => item.info.id) ?? [],
        pageHeader: boundaryPage.header,
        pageHeaderMessageID: cursorMessageID(boundaryPage.header),
        olderIDs: boundaryOlder.items?.map((item) => item.info.id) ?? [],
        boundarySeedIDs,
        rawBeforeStatus: rawBefore.status,
        rawBeforeErrorName: rawBefore.error?.name ?? null,
        rawBeforeRejected: rawBefore.status !== 200,
        beforeWithoutLimitStatus: beforeWithoutLimit.response?.status ?? null,
      },
      explicitMessageID: dispatchMessageID,
      explicitReceiptID: dispatch.data?.info?.parentID ?? null,
      dispatchMessageID,
      assistant,
      session: sessionRead.data,
    }
  }

  stateFile(sessionID) {
    return join(
      this.root,
      "state/opencode-stm",
      `${createHash("sha256").update(sessionID, "utf8").digest("hex")}.json`,
    )
  }

  readState(sessionID) {
    const path = this.stateFile(sessionID)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf8"))
    } catch {
      return null
    }
  }

  async waitForState(sessionID, predicate, timeoutMs = WAIT_TIMEOUT_MS) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const state = this.readState(sessionID)
      if (state !== null && predicate(state)) return state
      await delay(25)
    }
    throw new Error(`timed out waiting for STM state: ${JSON.stringify(this.readState(sessionID))}`)
  }

  async readParentTitle(sessionID = this.receipts.parentID) {
    if (typeof sessionID !== "string") throw new Error("no parent session to read")
    const result = await this.client.session.get({
      path: { id: sessionID },
      query: { directory: this.directory },
    })
    if (result.error !== undefined || !result.data) {
      throw new Error(`parent title read failed: ${JSON.stringify(result.error ?? null)}`)
    }
    return result.data.title
  }

  async readParentMessages(sessionID = this.receipts.parentID) {
    if (typeof sessionID !== "string") throw new Error("no parent session to read")
    return this.fullMessages(sessionID)
  }

  async promptParent(parentID, text) {
    const prompted = await this.client.session.prompt({
      path: { id: parentID },
      query: { directory: this.directory },
      body: {
        agent: PARENT_AGENT,
        model: { providerID: "probe", modelID: "mock" },
        parts: [{ type: "text", text }],
      },
    })
    if (prompted.error !== undefined) {
      throw new Error(`parent prompt failed: ${JSON.stringify(prompted.error)}`)
    }
    return prompted
  }

  startToolParts(items) {
    return items
      .flatMap((item) => item.parts ?? [])
      .filter((part) => part?.type === "tool" && part.tool === BACKGROUND_TOOL)
  }

  async dispatchViaMain({ permission, duplicate = false } = {}) {
    return withTimeout(
      this.runDispatchViaMain({ permission, duplicate }),
      WAIT_TIMEOUT_MS * 4,
      "background dispatch via main",
    )
  }

  async runDispatchViaMain({ permission, duplicate }) {
    const createBody = { title: "stm task8 parent" }
    if (Array.isArray(permission) && permission.length > 0) createBody.permission = permission
    const created = await this.client.session.create({
      body: createBody,
      query: { directory: this.directory },
    })
    if (created.error !== undefined || !created.data?.id) {
      throw new Error(`background parent create failed: ${JSON.stringify(created.error ?? null)}`)
    }
    const parentID = created.data.id
    const initialTitle = await this.readParentTitle(parentID)
    const encodedTitle = Buffer.from(initialTitle, "utf8").toString("base64")

    // A non-default title avoids the host's automatic first-title generation;
    // the provider then issues an explicit unlocked baseline through STM.
    await this.promptParent(
      parentID,
      `${BACKGROUND_UNLOCK_MARKER}\nEXPECTED_TITLE_B64=${encodedTitle}`,
    )
    await this.waitForIdle(parentID)
    const unlocked = await this.readToolOutput(parentID, BACKGROUND_UNLOCK_TOOL)
    if (unlocked.status !== "ok" || unlocked.locked !== false) {
      throw new Error(`background title unlock failed: ${JSON.stringify(unlocked)}`)
    }
    const titleBefore = await this.readParentTitle(parentID)

    // Establish the scheduler baseline, seed eligible stored activity, then let
    // the provider issue the dispatch tool call from the transformed request.
    await this.promptParent(parentID, BACKGROUND_SEED_MARKER)
    await this.waitForIdle(parentID)
    for (let index = 0; index < 20; index += 1) {
      const seeded = await this.client.session.prompt({
        path: { id: parentID },
        query: { directory: this.directory },
        body: {
          agent: PARENT_AGENT,
          noReply: true,
          parts: [{ type: "text", text: `background-activity-${index}` }],
        },
      })
      if (seeded.error !== undefined) throw new Error("background activity seed failed")
    }
    const dispatched = await this.promptParent(
      parentID,
      `${BACKGROUND_DISPATCH_MARKER}\nEXPECTED_TITLE_B64=${encodedTitle}`,
    )
    await this.waitForIdle(parentID)

    const items = await this.fullMessages(parentID)
    const toolParts = this.startToolParts(items)
    const toolPart = toolParts.find((part) => part.state?.status === "completed") ?? toolParts[0] ?? null
    const unavailablePart =
      items
        .flatMap((item) => item.parts ?? [])
        .find(
          (part) =>
            part?.type === "tool" &&
            part.tool === "invalid" &&
            part.state?.input?.tool === BACKGROUND_TOOL,
        ) ?? null
    let startStatus
    if (toolPart !== null) {
      if (toolPart.state?.status !== "completed") {
        throw new Error(`background dispatch did not complete: ${JSON.stringify(toolPart.state)}`)
      }
      try {
        startStatus = JSON.parse(toolPart.state.output)
      } catch {
        throw new Error("background dispatch output was not JSON")
      }
    } else if (unavailablePart !== null) {
      // The host hides a denied tool from the model. No coordinator code ran.
      startStatus = { status: "denied", reason: "tool-unavailable" }
    } else {
      throw new Error(`background dispatch tool was not recorded; logs: ${this.safeLogs()}`)
    }
    const callerMessage = items.find((item) =>
      (item.parts ?? []).some(
        (part) =>
          (part?.type === "tool" && part.tool === BACKGROUND_TOOL) ||
          (part?.type === "tool" && part.tool === "invalid" && part.state?.input?.tool === BACKGROUND_TOOL),
      ),
    )
    const state = this.readState(parentID)
    const dispatchRequest = this.requests.find((request) => request.kind === "background-dispatch")
    this.receipts = {
      parentID,
      titleBefore,
      dispatchAssistantMessageID: callerMessage?.info?.id ?? null,
      dispatchUserMessageID: dispatched.data?.info?.parentID ?? null,
      dispatchStatus: startStatus,
      dispatchToolCount: toolParts.length,
      duplicateDispatch: duplicate ?? null,
      providerSawReviewReminder: dispatchRequest?.containsReviewReminder ?? null,
      cutoffMessageID: state?.backgroundReview?.cutoffMessageID ?? null,
      childID: state?.backgroundReview?.childSessionID ?? null,
      promptMessageID: state?.backgroundReview?.promptMessageID ?? null,
      stateAtDispatch: state,
    }
    return this.receipts
  }

  async continueParent(text = "PARENT_CONTINUES_WHILE_REVIEW_PENDING") {
    if (typeof this.receipts.parentID !== "string") throw new Error("no dispatched parent session")
    const before = this.requests.length
    const parentBefore = await this.readParentMessages()
    const prompted = await this.promptParent(
      this.receipts.parentID,
      `${BACKGROUND_CONTINUE_MARKER}\n${text}`,
    )
    await this.waitForIdle(this.receipts.parentID)
    const request = this.requests
      .slice(before)
      .find((entry) => entry.kind === "background-continue")
    const parentAfter = await this.readParentMessages()
    this.receipts.parentContinuedBeforeReviewerRelease = this.provider.reviewHeld !== null
    this.receipts.parentContinue = {
      marker: request?.marker ?? null,
      childHeldAtRequest: request?.childHeldAtRequest ?? null,
      containsReviewReminder: request?.containsReviewReminder ?? null,
      assistantCompleted: typeof prompted.data?.info?.time?.completed === "number",
      assistantError: prompted.data?.info?.error ?? null,
      parentMessagesBefore: parentBefore.map((item) => item.info.id),
      parentMessagesAfter: parentAfter.map((item) => item.info.id),
    }
    return prompted
  }

  async lockParentViaMain() {
    if (typeof this.receipts.parentID !== "string") throw new Error("no dispatched parent session")
    const title = await this.readParentTitle()
    const encoded = Buffer.from(title, "utf8").toString("base64")
    const prompted = await this.promptParent(
      this.receipts.parentID,
      `${BACKGROUND_LOCK_MARKER}\nEXPECTED_TITLE_B64=${encoded}`,
    )
    await this.waitForIdle(this.receipts.parentID)
    const locked = await this.readLastToolOutput(this.receipts.parentID, BACKGROUND_UNLOCK_TOOL)
    this.receipts.manualLock = {
      result: locked,
      assistantCompleted: typeof prompted.data?.info?.time?.completed === "number",
    }
    return locked
  }

  async waitForReviewerResolution(expectedTitle, timeoutMs = WAIT_TIMEOUT_MS) {
    const state = await this.waitForState(
      this.receipts.parentID,
      (current) => current.backgroundReview === null && current.review === null,
      timeoutMs,
    )
    const title = await this.readParentTitle()
    if (expectedTitle !== undefined && title !== expectedTitle) {
      throw new Error(`reviewer resolution title mismatch: ${JSON.stringify(title)}`)
    }
    this.receipts.resolvedState = state
    this.receipts.resolvedTitle = title
    return { state, title }
  }

  async dispose({ keep = false } = {}) {
    if (this.cleaned) return
    this.cleaned = true
    if (this.child && this.child.pid) {
      const child = this.child
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch {
        try {
          child.kill("SIGTERM")
        } catch {}
      }
      const exited = await Promise.race([
        new Promise((resolve) => child.once("exit", () => resolve(true))),
        delay(PROCESS_EXIT_TIMEOUT_MS, false),
      ])
      if (exited !== true) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          try {
            child.kill("SIGKILL")
          } catch {}
        }
      }
    }
    await this.provider.stop()
    if (keep) {
      writeFileSync(
        join(this.root, "server-stdout.log"),
        this.stdout.split(this.serverPassword ?? "\u0000").join("<redacted>"),
      )
      writeFileSync(
        join(this.root, "server-stderr.log"),
        this.stderr.split(this.serverPassword ?? "\u0000").join("<redacted>"),
      )
      return
    }
    rmSync(this.root, { recursive: true, force: true })
  }
}

export async function withLoopbackHost(testContext, run, options = {}) {
  const host = new LoopbackHost(options)
  let failure = null
  testContext.after(async () => {
    await host.dispose({ keep: failure !== null })
    if (failure !== null) {
      testContext.diagnostic(`retained failed runtime root: ${host.root}`)
    }
  })
  try {
    await host.start()
    await run(host)
  } catch (error) {
    failure = error
    throw error
  }
}

export function assertRestrictedChildReceipts(receipts) {
  assert.deepEqual(receipts.structured, { decision: "keep" })
  assert.equal(receipts.validationError, null)
  assert.equal(receipts.selectedAgent, "stm-probe-reviewer")
  assert.equal(receipts.parentMessageCountAfter, receipts.parentMessageCountBefore)
  assert.equal(receipts.parentWakeCount, 0)
  assert.equal(receipts.unrelatedToolExecuted, false)
  assert.equal(receipts.injectedClientTransportVerified, true)
  assert.equal(receipts.hostileToolOffered, false)
  assert.equal(receipts.hostileToolPartStatus, "error")
  assert.equal(receipts.assistantCompleted, true)
  assert.equal(receipts.assistantError, null)
  assert.equal(receipts.childParentID, receipts.parentSessionID)
  assert.equal(receipts.childAgent, "stm-probe-reviewer")
}
