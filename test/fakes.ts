// test/fakes.ts
import type { Client } from "../src/sdk.js"

export type FakeResult = {
  data?: unknown
  error?: unknown
  response?: { status?: number; headers?: { get(name: string): string | null } }
}

export type FakeHandler = (options: any) => Promise<FakeResult>

export type FakeHandlers = {
  get?: FakeHandler
  update?: FakeHandler
  messages?: FakeHandler
  create?: FakeHandler
  promptAsync?: FakeHandler
  abort?: FakeHandler
  status?: FakeHandler
  message?: FakeHandler
  agents?: FakeHandler
}

export function fakeClient(handlers: FakeHandlers): {
  client: Client
  calls: Array<{ method: string; options: any }>
} {
  const calls: Array<{ method: string; options: any }> = []
  const wrap = (method: string, namespace: string, handler?: FakeHandler) =>
    async (options: any): Promise<FakeResult> => {
      calls.push({ method, options })
      if (handler === undefined) throw new Error(`unexpected ${namespace}.${method} call`)
      return handler(options)
    }
  const client = {
    session: {
      get: wrap("get", "session", handlers.get),
      update: wrap("update", "session", handlers.update),
      messages: wrap("messages", "session", handlers.messages),
      create: wrap("create", "session", handlers.create),
      promptAsync: wrap("promptAsync", "session", handlers.promptAsync),
      abort: wrap("abort", "session", handlers.abort),
      status: wrap("status", "session", handlers.status),
      message: wrap("message", "session", handlers.message),
    },
    app: {
      agents: wrap("agents", "app", handlers.agents),
    },
  } as unknown as Client
  return { client, calls }
}

export function headerResponse(name: string, value: string | null): { headers: { get(name: string): string | null } } {
  return { headers: { get: (asked: string) => (asked.toLowerCase() === name.toLowerCase() ? value : null) } }
}
