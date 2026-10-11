// test/fakes.ts
import type { Client } from "../src/sdk.js"

export type FakeResult = {
  data?: unknown
  error?: unknown
  response?: { headers: { get(name: string): string | null } }
}

export type FakeHandler = (options: any) => Promise<FakeResult>

export function fakeClient(handlers: { get?: FakeHandler; update?: FakeHandler; messages?: FakeHandler }): {
  client: Client
  calls: Array<{ method: string; options: any }>
} {
  const calls: Array<{ method: string; options: any }> = []
  const wrap = (method: string, handler?: FakeHandler) => async (options: any): Promise<FakeResult> => {
    calls.push({ method, options })
    if (handler === undefined) throw new Error(`unexpected session.${method} call`)
    return handler(options)
  }
  const client = {
    session: {
      get: wrap("get", handlers.get),
      update: wrap("update", handlers.update),
      messages: wrap("messages", handlers.messages),
    },
  } as unknown as Client
  return { client, calls }
}

export function headerResponse(name: string, value: string | null): { headers: { get(name: string): string | null } } {
  return { headers: { get: (asked: string) => (asked.toLowerCase() === name.toLowerCase() ? value : null) } }
}
