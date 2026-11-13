import type { PluginInput } from "@opencode-ai/plugin"

export type Client = PluginInput["client"]

export type SdkResult<T> = { ok: true; value: T } | { ok: false; reason: string }

export type SessionInfo = { id: string; title: string; parentID?: string }

export const MESSAGE_PAGE_LIMIT = 8

export async function readSession(
  client: Client,
  sessionID: string,
  signal?: AbortSignal,
): Promise<SdkResult<SessionInfo>> {
  try {
    const result = await client.session.get({ path: { id: sessionID }, signal })
    if (result.error !== undefined && result.error !== null) {
      return { ok: false, reason: "sdk: session read rejected" }
    }
    const data = result.data
    if (data === undefined || data.id !== sessionID || typeof data.title !== "string") {
      return { ok: false, reason: "sdk: session read returned unexpected data" }
    }
    return {
      ok: true,
      value: data.parentID === undefined
        ? { id: data.id, title: data.title }
        : { id: data.id, title: data.title, parentID: data.parentID },
    }
  } catch {
    return { ok: false, reason: "sdk: session read failed" }
  }
}

export async function writeTitle(
  client: Client,
  sessionID: string,
  title: string,
  signal?: AbortSignal,
): Promise<SdkResult<{ id: string }>> {
  try {
    const result = await client.session.update({ path: { id: sessionID }, body: { title }, signal })
    if (result.error !== undefined && result.error !== null) {
      return { ok: false, reason: "sdk: title update rejected" }
    }
    const data = result.data
    if (data === undefined || data.id !== sessionID) {
      return { ok: false, reason: "sdk: title update returned unexpected data" }
    }
    return { ok: true, value: { id: data.id } }
  } catch {
    return { ok: false, reason: "sdk: title update failed" }
  }
}

export type PagePart = {
  id?: string
  type?: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  tool?: string
  messageID?: string
  [key: string]: unknown
}

export type PageMessage = {
  info: { id: string; sessionID: string; role: string; summary?: unknown }
  parts: PagePart[]
}

export type PageResult = { items: PageMessage[]; nextCursor: string | null }

export async function page(
  client: Client,
  sessionID: string,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<SdkResult<PageResult>> {
  // The published v1 query type omits `before`; the 1.18.35 runtime accepts it.
  // Keep this single additive cast here so no other module depends on the gap.
  const query = {
    limit: MESSAGE_PAGE_LIMIT,
    ...(cursor === undefined ? {} : { before: cursor }),
  } as { limit: number; before?: string }
  try {
    const result = await client.session.messages({ path: { id: sessionID }, query, signal })
    if (result.error !== undefined && result.error !== null) {
      return { ok: false, reason: "sdk: message page rejected" }
    }
    if (!Array.isArray(result.data)) {
      return { ok: false, reason: "sdk: message page returned unexpected data" }
    }
    const header = result.response?.headers?.get("x-next-cursor") ?? null
    return {
      ok: true,
      value: { items: result.data as PageMessage[], nextCursor: header !== null && header.length > 0 ? header : null },
    }
  } catch {
    return { ok: false, reason: "sdk: message page failed" }
  }
}

export type RootCache = {
  isRoot(sessionID: string, signal?: AbortSignal): Promise<SdkResult<boolean>>
  remember(sessionID: string, value: boolean): void
  invalidate(sessionID: string): void
  clear(): void
}

export function createRootCache(client: Client, max = 256): RootCache {
  const entries = new Map<string, boolean>()
  const insert = (sessionID: string, value: boolean): void => {
    entries.delete(sessionID)
    entries.set(sessionID, value)
    while (entries.size > max) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }
  return {
    async isRoot(sessionID, signal) {
      const cached = entries.get(sessionID)
      if (cached !== undefined) {
        insert(sessionID, cached)
        return { ok: true, value: cached }
      }
      const read = await readSession(client, sessionID, signal)
      if (!read.ok) return { ok: false, reason: read.reason }
      const isRoot = read.value.parentID === undefined
      insert(sessionID, isRoot)
      return { ok: true, value: isRoot }
    },
    remember(sessionID, value) {
      insert(sessionID, value)
    },
    invalidate(sessionID) {
      entries.delete(sessionID)
    },
    clear() {
      entries.clear()
    },
  }
}

// Background review adapter. The installed v1 SDK types omit fields that the
// running host accepts (create agent/permission, prompt variant, raw session
// permission). Keep every compatibility cast inside this module and validate
// the responses before returning them to callers.

export type ReviewAgent = {
  name: string
  model: { providerID: string; modelID: string }
  variant?: string
}

export type PermissionRule = {
  permission: string
  pattern: string
  action: "allow" | "ask" | "deny"
}

export type ReviewExecutionContext = {
  agent: ReviewAgent
  childPermissions: PermissionRule[]
  dispatchParentID: string
}

export type ReviewCompletion =
  | { status: "pending" }
  | { status: "complete"; structured: unknown }
  | { status: "error"; reason: string }

type ApiResponse = {
  data?: unknown
  error?: unknown
  response?: { status?: number; headers?: { get(name: string): string | null } }
}

type ReviewCreateBody = {
  parentID: string
  title: string
  agent: string
  permission: PermissionRule[]
}

type ReviewPromptBody = {
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  messageID: string
  parts: Array<{ type: "text"; text: string }>
}

type ReviewSessionApi = {
  get(input: { path: { id: string }; signal?: AbortSignal }): Promise<ApiResponse>
  message(input: {
    path: { id: string; messageID: string }
    signal?: AbortSignal
  }): Promise<ApiResponse>
  create(input: { body: ReviewCreateBody; signal?: AbortSignal }): Promise<ApiResponse>
  promptAsync(input: {
    path: { id: string }
    body: ReviewPromptBody
    signal?: AbortSignal
  }): Promise<ApiResponse>
  messages(input: { path: { id: string }; signal?: AbortSignal }): Promise<ApiResponse>
  abort(input: { path: { id: string }; signal?: AbortSignal }): Promise<ApiResponse>
  status(input: { signal?: AbortSignal }): Promise<ApiResponse>
}

type ReviewClient = {
  session: ReviewSessionApi
  app: { agents(input?: { signal?: AbortSignal }): Promise<ApiResponse> }
  provider: { list(input?: { signal?: AbortSignal }): Promise<ApiResponse> }
}

function reviewClient(client: Client): ReviewClient {
  return client as unknown as ReviewClient
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function apiFailure(reason: string): { ok: false; reason: string } {
  return { ok: false, reason }
}

function apiRejected(result: ApiResponse): boolean {
  return result.error !== undefined && result.error !== null
}

const FINAL_DENY: PermissionRule = { permission: "*", pattern: "*", action: "deny" }

function isAction(value: unknown): value is PermissionRule["action"] {
  return value === "allow" || value === "ask" || value === "deny"
}

function parsePermissionRules(value: unknown): PermissionRule[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const rules: PermissionRule[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return null
    if (!isNonEmptyString(raw.permission) || !isNonEmptyString(raw.pattern)) return null
    if (!isAction(raw.action)) return null
    rules.push({ permission: raw.permission, pattern: raw.pattern, action: raw.action })
  }
  return rules
}

// The last matching rule wins. Never synthesise an allow rule; append exactly
// one final wildcard denial so no earlier allow can survive.
function withFinalDeny(rules: PermissionRule[]): PermissionRule[] {
  const retained = rules.filter(
    (rule) => !(rule.permission === "*" && rule.pattern === "*" && rule.action === "deny"),
  )
  return [...retained, { ...FINAL_DENY }]
}

type ParsedAgent = {
  name: string
  mode: "subagent" | "primary" | "all"
  model?: ReviewAgent["model"]
  variant?: string
  disabled: boolean
}

function parseAgent(raw: unknown): ParsedAgent | null {
  if (!isRecord(raw)) return null
  if (!isNonEmptyString(raw.name)) return null
  if (raw.mode !== "subagent" && raw.mode !== "primary" && raw.mode !== "all") return null
  const disabled = raw.disable === true || raw.disabled === true || raw.enabled === false

  let model: ReviewAgent["model"] | undefined
  let variant: string | undefined
  if (raw.model !== undefined && raw.model !== null) {
    if (!isRecord(raw.model)) return null
    const providerID = isNonEmptyString(raw.model.providerID) ? raw.model.providerID : null
    const modelID = isNonEmptyString(raw.model.modelID)
      ? raw.model.modelID
      : isNonEmptyString(raw.model.id)
        ? raw.model.id
        : null
    if (providerID === null || modelID === null) return null
    model = { providerID, modelID }
    if (raw.model.variant !== undefined && raw.model.variant !== null) {
      if (!isNonEmptyString(raw.model.variant)) return null
      variant = raw.model.variant
    }
  }
  if (raw.variant !== undefined && raw.variant !== null) {
    if (!isNonEmptyString(raw.variant)) return null
    variant = raw.variant
  }
  return { name: raw.name, mode: raw.mode, model, variant, disabled }
}

type AgentLookup = { ok: true; value: ParsedAgent } | { ok: false; reason: string }

function findAgent(rawAgents: unknown[], name: string, label: "caller" | "reviewer"): AgentLookup {
  let found: ParsedAgent | null = null
  for (const raw of rawAgents) {
    if (!isRecord(raw) || raw.name !== name) continue
    const parsed = parseAgent(raw)
    if (parsed === null) return apiFailure("sdk: review context agent list returned unexpected data")
    if (found !== null) return apiFailure("sdk: review context agent list returned unexpected data")
    found = parsed
  }
  if (found === null) return apiFailure(`sdk: review context ${label} agent missing`)
  return { ok: true, value: found }
}

type DispatchInfo = { model?: ReviewAgent["model"]; variant?: string; parentID: string }
type DispatchLookup = { ok: true; value: DispatchInfo } | { ok: false; reason: string }

function parseDispatchMessage(raw: unknown, parentID: string, messageID: string): DispatchLookup {
  if (!isRecord(raw) || !isRecord(raw.info)) {
    return apiFailure("sdk: review context dispatch message returned unexpected data")
  }
  const info = raw.info
  if (info.id !== messageID || info.sessionID !== parentID) {
    return apiFailure("sdk: review context dispatch message returned unexpected data")
  }
  if (info.role !== "assistant" || !isNonEmptyString(info.parentID)) {
    return apiFailure("sdk: review context dispatch message returned unexpected data")
  }

  let model: ReviewAgent["model"] | undefined
  let variant: string | undefined
  if (info.model !== undefined && info.model !== null) {
    if (!isRecord(info.model)) {
      return apiFailure("sdk: review context dispatch message returned unexpected data")
    }
    const providerID = isNonEmptyString(info.model.providerID) ? info.model.providerID : null
    const modelID = isNonEmptyString(info.model.modelID)
      ? info.model.modelID
      : isNonEmptyString(info.model.id)
        ? info.model.id
        : null
    if (providerID === null || modelID === null) {
      return apiFailure("sdk: review context dispatch message returned unexpected data")
    }
    model = { providerID, modelID }
    if (info.model.variant !== undefined && info.model.variant !== null) {
      if (!isNonEmptyString(info.model.variant)) {
        return apiFailure("sdk: review context dispatch message returned unexpected data")
      }
      variant = info.model.variant
    }
  } else if (info.providerID !== undefined || info.modelID !== undefined) {
    if (!isNonEmptyString(info.providerID) || !isNonEmptyString(info.modelID)) {
      return apiFailure("sdk: review context dispatch message returned unexpected data")
    }
    model = { providerID: info.providerID, modelID: info.modelID }
  }
  if (info.variant !== undefined && info.variant !== null) {
    if (!isNonEmptyString(info.variant)) {
      return apiFailure("sdk: review context dispatch message returned unexpected data")
    }
    variant = info.variant
  }
  return { ok: true, value: { model, variant, parentID: info.parentID } }
}

function parseReviewerModel(value: unknown): ReviewAgent["model"] | null {
  if (typeof value !== "string") return null
  const segments = value.split("/")
  if (segments.length < 2 || segments.some((segment) => segment.length === 0 || /\s/.test(segment))) return null
  return { providerID: segments[0]!, modelID: segments.slice(1).join("/") }
}

type ProviderCatalog = {
  providers: Map<string, Map<string, string>>
  connected: Set<string>
}

function parseProviderCatalog(value: unknown): ProviderCatalog | null {
  if (!isRecord(value) || !Array.isArray(value.all) || !Array.isArray(value.connected)) return null
  const providers = new Map<string, Map<string, string>>()
  for (const rawProvider of value.all) {
    if (!isRecord(rawProvider) || !isNonEmptyString(rawProvider.id) || !isRecord(rawProvider.models)) return null
    if (providers.has(rawProvider.id)) return null
    const models = new Map<string, string>()
    for (const [modelKey, rawModel] of Object.entries(rawProvider.models)) {
      if (!isRecord(rawModel) || !isNonEmptyString(rawModel.id)) return null
      models.set(modelKey, rawModel.id)
    }
    providers.set(rawProvider.id, models)
  }

  const connected = new Set<string>()
  for (const providerID of value.connected) {
    if (!isNonEmptyString(providerID) || connected.has(providerID)) return null
    connected.add(providerID)
  }
  return { providers, connected }
}

async function validateReviewerModel(
  api: ReviewClient,
  model: ReviewAgent["model"],
  signal: AbortSignal,
): Promise<SdkResult<null>> {
  if (signal.aborted) return apiFailure("sdk: review context aborted")
  try {
    const result = await api.provider.list({ signal })
    if (signal.aborted) return apiFailure("sdk: review context aborted")
    if (apiRejected(result)) {
      return apiFailure("config: review.reviewer.model could not be verified against connected providers")
    }
    const catalog = parseProviderCatalog(result.data)
    if (catalog === null) {
      return apiFailure("config: review.reviewer.model could not be verified against connected providers")
    }
    const models = catalog.providers.get(model.providerID)
    if (
      !catalog.connected.has(model.providerID) ||
      models === undefined ||
      models.get(model.modelID) !== model.modelID
    ) {
      return apiFailure("config: review.reviewer.model is not available from a connected provider")
    }
    return { ok: true, value: null }
  } catch {
    if (signal.aborted) return apiFailure("sdk: review context aborted")
    return apiFailure("config: review.reviewer.model could not be verified against connected providers")
  }
}

function validReviewAgent(agent: ReviewAgent): boolean {
  return (
    isRecord(agent) &&
    isNonEmptyString(agent.name) &&
    isRecord(agent.model) &&
    isNonEmptyString(agent.model.providerID) &&
    isNonEmptyString(agent.model.modelID) &&
    (agent.variant === undefined || isNonEmptyString(agent.variant))
  )
}

export async function readReviewExecutionContext(
  client: Client,
  input: {
    parentID: string
    messageID: string
    callerAgent: string
    reviewerAgent: string
    model?: string
  },
  signal: AbortSignal,
): Promise<SdkResult<ReviewExecutionContext>> {
  if (
    !isNonEmptyString(input.parentID) ||
    !isNonEmptyString(input.messageID) ||
    !isNonEmptyString(input.callerAgent) ||
    !isNonEmptyString(input.reviewerAgent)
  ) {
    return apiFailure("sdk: review context invalid input")
  }
  const explicitModel = input.model === undefined ? undefined : parseReviewerModel(input.model)
  if (explicitModel === null) {
    return apiFailure("config: review.reviewer.model must be provider/model-id without whitespace")
  }
  if (signal.aborted) return apiFailure("sdk: review context aborted")

  const api = reviewClient(client)
  try {
    const agentsResult = await api.app.agents({ signal })
    if (signal.aborted) return apiFailure("sdk: review context aborted")
    if (apiRejected(agentsResult)) return apiFailure("sdk: review context agent list rejected")
    if (!Array.isArray(agentsResult.data)) {
      return apiFailure("sdk: review context agent list returned unexpected data")
    }

    const caller = findAgent(agentsResult.data, input.callerAgent, "caller")
    if (!caller.ok) return caller
    if (caller.value.disabled) return apiFailure("sdk: review context caller agent unavailable")
    const reviewer = findAgent(agentsResult.data, input.reviewerAgent, "reviewer")
    if (!reviewer.ok) return reviewer
    if (reviewer.value.disabled) return apiFailure("sdk: review context reviewer agent unavailable")
    if (reviewer.value.mode === "primary") {
      return apiFailure("sdk: review context reviewer agent is primary-only")
    }

    const messageResult = await api.session.message({
      path: { id: input.parentID, messageID: input.messageID },
      signal,
    })
    if (signal.aborted) return apiFailure("sdk: review context aborted")
    if (apiRejected(messageResult)) {
      return apiFailure("sdk: review context dispatch message rejected")
    }
    const dispatch = parseDispatchMessage(messageResult.data, input.parentID, input.messageID)
    if (!dispatch.ok) return dispatch

    let model = explicitModel
    let variant: string | undefined
    if (model === undefined) {
      model = dispatch.value.model
      variant = dispatch.value.variant
    }
    if (model === undefined) return apiFailure("sdk: review context dispatch model missing")

    const modelAvailable = await validateReviewerModel(api, model, signal)
    if (!modelAvailable.ok) return modelAvailable

    const sessionResult = await api.session.get({ path: { id: input.parentID }, signal })
    if (signal.aborted) return apiFailure("sdk: review context aborted")
    if (apiRejected(sessionResult)) return apiFailure("sdk: review session read rejected")
    const session = sessionResult.data
    if (!isRecord(session) || session.id !== input.parentID) {
      return apiFailure("sdk: review session read returned unexpected data")
    }
    const parentPermissions = parsePermissionRules(session.permission)
    if (parentPermissions === null) {
      return apiFailure("sdk: review session permission returned unexpected data")
    }
    const restrictions = parentPermissions.filter((rule) => rule.action !== "allow")

    const agent: ReviewAgent = {
      name: reviewer.value.name,
      model,
      ...(variant === undefined ? {} : { variant }),
    }
    return {
      ok: true,
      value: {
        agent,
        childPermissions: withFinalDeny(restrictions),
        dispatchParentID: dispatch.value.parentID,
      },
    }
  } catch {
    return apiFailure("sdk: review context failed")
  }
}

export async function createReviewChild(
  client: Client,
  input: {
    parentID: string
    agent: ReviewAgent
    permissions: PermissionRule[]
    attemptID: string
  },
  signal: AbortSignal,
): Promise<SdkResult<{ id: string }>> {
  if (
    !isNonEmptyString(input.parentID) ||
    !isNonEmptyString(input.attemptID) ||
    !validReviewAgent(input.agent)
  ) {
    return apiFailure("sdk: review child invalid input")
  }
  const permissions = parsePermissionRules(input.permissions)
  if (permissions === null) return apiFailure("sdk: review child invalid input")
  if (signal.aborted) return apiFailure("sdk: review child create aborted")

  const api = reviewClient(client)
  try {
    const result = await api.session.create({
      body: {
        parentID: input.parentID,
        title: `STM title review ${input.attemptID}`,
        agent: input.agent.name,
        permission: withFinalDeny(permissions),
      },
      signal,
    })
    if (signal.aborted) return apiFailure("sdk: review child create aborted")
    if (apiRejected(result)) return apiFailure("sdk: review child create rejected")
    const data = result.data
    if (!isRecord(data) || !isNonEmptyString(data.id)) {
      return apiFailure("sdk: review child create returned unexpected data")
    }
    if (data.parentID !== undefined && data.parentID !== input.parentID) {
      return apiFailure("sdk: review child create returned unexpected data")
    }
    return { ok: true, value: { id: data.id } }
  } catch {
    return apiFailure("sdk: review child create failed")
  }
}

export async function promptReviewChild(
  client: Client,
  input: {
    childID: string
    promptMessageID: string
    agent: ReviewAgent
    text: string
  },
  signal: AbortSignal,
): Promise<SdkResult<null>> {
  if (
    !isNonEmptyString(input.childID) ||
    !isNonEmptyString(input.promptMessageID) ||
    !validReviewAgent(input.agent) ||
    !isNonEmptyString(input.text)
  ) {
    return apiFailure("sdk: review prompt invalid input")
  }
  if (signal.aborted) return apiFailure("sdk: review prompt aborted")

  const body: ReviewPromptBody = {
    agent: input.agent.name,
    model: {
      providerID: input.agent.model.providerID,
      modelID: input.agent.model.modelID,
    },
    messageID: input.promptMessageID,
    parts: [{ type: "text", text: input.text }],
  }
  if (input.agent.variant !== undefined) body.variant = input.agent.variant

  const api = reviewClient(client)
  try {
    const result = await api.session.promptAsync({ path: { id: input.childID }, body, signal })
    if (signal.aborted) return apiFailure("sdk: review prompt aborted")
    if (apiRejected(result)) return apiFailure("sdk: review prompt rejected")
    // The accepted response is 204 with no body; only the absence of an error
    // is required.
    return { ok: true, value: null }
  } catch {
    return apiFailure("sdk: review prompt failed")
  }
}

type CompletionMessage = { info: Record<string, unknown>; parts: unknown[] }

function parseCompletionMessage(raw: unknown, childID: string): SdkResult<CompletionMessage | null> {
  if (!isRecord(raw) || !isRecord(raw.info)) {
    return apiFailure("sdk: review completion returned unexpected data")
  }
  const info = raw.info
  if (!isNonEmptyString(info.id) || !isNonEmptyString(info.sessionID)) {
    return apiFailure("sdk: review completion returned unexpected data")
  }
  if (info.sessionID !== childID) return { ok: true, value: null }
  if (info.role !== "user" && info.role !== "assistant") {
    return apiFailure("sdk: review completion returned unexpected data")
  }
  if (!Array.isArray(raw.parts)) {
    return apiFailure("sdk: review completion returned unexpected data")
  }
  return { ok: true, value: { info, parts: raw.parts } }
}

type VisibleText = { ok: true; text: string } | { ok: false; reason: string }

function completionVisibleText(parts: unknown[], childID: string, messageID: string): VisibleText {
  let text = ""
  for (const raw of parts) {
    if (!isRecord(raw) || typeof raw.type !== "string") {
      return { ok: false, reason: "malformed-completion" }
    }
    if (raw.type === "tool" || raw.type === "subtask") {
      return { ok: false, reason: "tool-bearing" }
    }
    if (raw.type === "text") {
      if (typeof raw.text !== "string") {
        return { ok: false, reason: "malformed-completion" }
      }
      if (raw.synthetic === true || raw.ignored === true) continue
      if (raw.sessionID !== undefined && raw.sessionID !== childID) {
        return { ok: false, reason: "malformed-completion" }
      }
      if (raw.messageID !== undefined && raw.messageID !== messageID) {
        return { ok: false, reason: "malformed-completion" }
      }
      text += raw.text
      continue
    }
    if (raw.type === "reasoning" || raw.type === "step-start" || raw.type === "step-finish") {
      continue
    }
    return { ok: false, reason: "malformed-completion" }
  }
  return { ok: true, text }
}

function completionError(reason: string): SdkResult<ReviewCompletion> {
  return { ok: true, value: { status: "error", reason } }
}

export async function readReviewCompletion(
  client: Client,
  childID: string,
  promptMessageID: string,
  signal: AbortSignal,
): Promise<SdkResult<ReviewCompletion>> {
  if (!isNonEmptyString(childID) || !isNonEmptyString(promptMessageID)) {
    return apiFailure("sdk: review completion invalid input")
  }
  if (signal.aborted) return apiFailure("sdk: review completion aborted")

  const api = reviewClient(client)
  try {
    const result = await api.session.messages({ path: { id: childID }, signal })
    if (signal.aborted) return apiFailure("sdk: review completion aborted")
    if (apiRejected(result)) return apiFailure("sdk: review completion rejected")
    if (!Array.isArray(result.data)) {
      return apiFailure("sdk: review completion returned unexpected data")
    }

    const users: CompletionMessage[] = []
    const assistants: CompletionMessage[] = []
    for (const raw of result.data) {
      const parsed = parseCompletionMessage(raw, childID)
      if (!parsed.ok) return parsed
      if (parsed.value === null) continue
      if (parsed.value.info.role === "user") users.push(parsed.value)
      else assistants.push(parsed.value)
    }

    const reserved = users.filter((message) => message.info.id === promptMessageID)
    if (reserved.length !== users.length) return completionError("foreign-prompt")
    if (reserved.length === 0) return { ok: true, value: { status: "pending" } }
    if (reserved.length > 1) return completionError("malformed-completion")

    let sawError = false
    const finals: string[] = []
    for (const message of assistants) {
      const info = message.info
      if (info.parentID !== promptMessageID) return completionError("foreign-message")
      if (info.error !== undefined && info.error !== null) {
        sawError = true
        continue
      }
      if (info.summary === true || isRecord(info.summary)) {
        return completionError("malformed-completion")
      }
      const time = info.time
      const completed = isRecord(time) && typeof time.completed === "number"
      if (!completed) continue
      const visible = completionVisibleText(message.parts, childID, String(info.id))
      if (!visible.ok) return completionError(visible.reason)
      finals.push(visible.text)
    }

    if (sawError) return completionError("assistant-error")
    if (finals.length === 0) return { ok: true, value: { status: "pending" } }

    const unique = [...new Set(finals)]
    if (unique.length > 1) return completionError("incompatible-results")
    const text = unique[0]!
    let structured: unknown
    try {
      structured = JSON.parse(text)
    } catch {
      return completionError("invalid-json")
    }
    return { ok: true, value: { status: "complete", structured } }
  } catch {
    return apiFailure("sdk: review completion failed")
  }
}

export async function stopReviewChild(
  client: Client,
  childID: string,
  signal: AbortSignal,
): Promise<SdkResult<{ confirmed: boolean }>> {
  if (!isNonEmptyString(childID)) return apiFailure("sdk: review child invalid input")
  const unconfirmed: SdkResult<{ confirmed: boolean }> = { ok: true, value: { confirmed: false } }
  if (signal.aborted) return unconfirmed

  const api = reviewClient(client)
  try {
    const abortResult = await api.session.abort({ path: { id: childID }, signal })
    if (apiRejected(abortResult) || abortResult.data !== true) return unconfirmed

    const statusResult = await api.session.status({ signal })
    if (apiRejected(statusResult) || !isRecord(statusResult.data)) return unconfirmed
    const current = statusResult.data[childID]
    if (!isRecord(current) || current.type !== "idle") return unconfirmed
    return { ok: true, value: { confirmed: true } }
  } catch {
    return unconfirmed
  }
}
