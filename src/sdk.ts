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
