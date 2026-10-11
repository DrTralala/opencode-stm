import { createHash, randomUUID } from "node:crypto"
import { chmodSync, closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs"
import { isAbsolute, join } from "node:path"

export const STATE_SCHEMA_VERSION = 1
export const FRONTIER_MAX = 64
export const ANCHOR_MAX = 32

export type LockReason =
  | "none"
  | "manual"
  | "external"
  | "non-default-title"
  | "historical"
  | "unreadable-state"
  | "invalid-config"

export type ReviewState = { id: string; remindersSent: number; nextTriggerAt: number }

export type AnchorState = {
  reviewID: string
  reminderIndex: number
  anchorMessageID: string
  partID: string
  obsolete: boolean
}

export type SessionMeta = {
  schemaVersion: 1
  activity: number
  baselineMessageID: string | null
  frontier: string[]
  review: ReviewState | null
  anchors: AnchorState[]
  locked: boolean
  lockReason: LockReason
  titleDigest: string | null
}

export function initialMeta(): SessionMeta {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    activity: 0,
    baselineMessageID: null,
    frontier: [],
    review: null,
    anchors: [],
    locked: false,
    lockReason: "none",
    titleDigest: null,
  }
}

export function hashSessionID(sessionID: string): string {
  return createHash("sha256").update(sessionID, "utf8").digest("hex")
}

export function hashTitle(title: string): string {
  return createHash("sha256").update(title, "utf8").digest("hex")
}

export function resolveStateDir(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_STATE_HOME
  const base = xdg !== undefined && xdg.length > 0 && isAbsolute(xdg) ? xdg : join(home, ".local", "state")
  return join(base, "opencode-stm")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

const LOCK_REASONS: readonly LockReason[] = [
  "none", "manual", "external", "non-default-title", "historical", "unreadable-state", "invalid-config",
]

const META_KEYS = [
  "schemaVersion", "activity", "baselineMessageID", "frontier", "review", "anchors", "locked", "lockReason", "titleDigest",
] as const
const REVIEW_KEYS = ["id", "remindersSent", "nextTriggerAt"] as const
const ANCHOR_KEYS = ["reviewID", "reminderIndex", "anchorMessageID", "partID", "obsolete"] as const

function isReviewState(value: unknown): value is ReviewState {
  if (!isRecord(value)) return false
  if (!hasOnlyKeys(value, REVIEW_KEYS)) return false
  return (
    typeof value.id === "string" &&
    Number.isInteger(value.remindersSent) &&
    (value.remindersSent as number) >= 0 &&
    Number.isInteger(value.nextTriggerAt) &&
    (value.nextTriggerAt as number) >= 0
  )
}

function isAnchorState(value: unknown): value is AnchorState {
  if (!isRecord(value)) return false
  if (!hasOnlyKeys(value, ANCHOR_KEYS)) return false
  return (
    typeof value.reviewID === "string" &&
    Number.isInteger(value.reminderIndex) &&
    (value.reminderIndex as number) >= 0 &&
    typeof value.anchorMessageID === "string" &&
    typeof value.partID === "string" &&
    typeof value.obsolete === "boolean"
  )
}

export function parseMeta(value: unknown): SessionMeta | null {
  if (!isRecord(value)) return null
  if (!hasOnlyKeys(value, META_KEYS)) return null
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) return null
  if (!Number.isInteger(value.activity) || (value.activity as number) < 0) return null
  if (!(value.baselineMessageID === null || typeof value.baselineMessageID === "string")) return null
  if (!Array.isArray(value.frontier) || value.frontier.length > FRONTIER_MAX || !value.frontier.every((item) => typeof item === "string")) return null
  if (!(value.review === null || isReviewState(value.review))) return null
  if (!Array.isArray(value.anchors) || value.anchors.length > ANCHOR_MAX || !value.anchors.every(isAnchorState)) return null
  if (typeof value.locked !== "boolean") return null
  if (typeof value.lockReason !== "string" || !LOCK_REASONS.includes(value.lockReason as LockReason)) return null
  if (!(value.titleDigest === null || typeof value.titleDigest === "string")) return null
  return value as SessionMeta
}

export type LoadResult = { ok: true; value: SessionMeta | null } | { ok: false; reason: string }
export type SaveResult = { ok: true } | { ok: false; reason: string }
export type UpdateResult<T> = { ok: true; value: T } | { ok: false; reason: string }
export type StateStoreOptions = { stateDir: string; now?: () => number }

export interface StateStore {
  load(sessionID: string): Promise<LoadResult>
  save(sessionID: string, meta: SessionMeta): Promise<SaveResult>
  update<T>(sessionID: string, fn: (current: SessionMeta | null) => { next: SessionMeta; result: T }): Promise<UpdateResult<T>>
  removeOwned(sessionID: string): Promise<void>
}

export type OperationGuard = { run<T>(key: string, fn: () => Promise<T>): Promise<T> }

export function createOperationGuard(): OperationGuard {
  const tails = new Map<string, Promise<void>>()
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()
      const result = previous.then(fn, fn)
      const tail = result.then(
        () => undefined,
        () => undefined,
      )
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return result
    },
  }
}

export function createStateStore(options: StateStoreOptions): StateStore {
  const queueTails = new Map<string, Promise<void>>()

  function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = queueTails.get(key) ?? Promise.resolve()
    const result = previous.then(task, task)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    queueTails.set(key, tail)
    void tail.then(() => {
      if (queueTails.get(key) === tail) queueTails.delete(key)
    })
    return result
  }

  function paths(sessionID: string) {
    const name = hashSessionID(sessionID)
    return {
      file: join(options.stateDir, `${name}.json`),
      lock: join(options.stateDir, `${name}.lock`),
      temp: (): string => join(options.stateDir, `${name}.${process.pid}.${randomUUID()}.tmp`),
    }
  }

  function ensureDir(): void {
    // Fails closed: a directory that cannot be created or locked to mode 0700
    // must disable persistence instead of falling back to permissive defaults.
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
    chmodSync(options.stateDir, 0o700)
  }

  class StoreLockError extends Error {
    constructor(readonly reason: string) {
      super(reason)
    }
  }

  function withFileLock<T>(sessionID: string, fn: () => T): T {
    let lockFd: number
    try {
      lockFd = openSync(paths(sessionID).lock, "wx", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StoreLockError("state: lock contention")
      throw new StoreLockError("state: lock unavailable")
    }
    try {
      return fn()
    } finally {
      closeSync(lockFd)
      rmSync(paths(sessionID).lock, { force: true })
    }
  }

  function readUnlocked(sessionID: string): LoadResult {
    let text: string
    try {
      text = readFileSync(paths(sessionID).file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: null }
      return { ok: false, reason: "state: unreadable" }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, reason: "state: malformed or unsupported" }
    }
    const meta = parseMeta(parsed)
    if (meta === null) return { ok: false, reason: "state: malformed or unsupported" }
    return { ok: true, value: meta }
  }

  function writeUnlocked(sessionID: string, meta: SessionMeta): SaveResult {
    const temp = paths(sessionID).temp()
    try {
      const fd = openSync(temp, "w", 0o600)
      try {
        fchmodSync(fd, 0o600)
        writeSync(fd, `${JSON.stringify(meta)}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, paths(sessionID).file)
      return { ok: true }
    } catch {
      rmSync(temp, { force: true })
      return { ok: false, reason: "state: save failed" }
    }
  }

  return {
    load(sessionID) {
      return enqueue(sessionID, async () => {
        try {
          ensureDir()
        } catch {
          return { ok: false, reason: "state: directory unavailable" }
        }
        try {
          return withFileLock(sessionID, () => readUnlocked(sessionID))
        } catch (error) {
          if (error instanceof StoreLockError) return { ok: false, reason: error.reason }
          return { ok: false, reason: "state: failed" }
        }
      })
    },
    save(sessionID, meta) {
      return enqueue(sessionID, async () => {
        try {
          ensureDir()
        } catch {
          return { ok: false, reason: "state: directory unavailable" }
        }
        try {
          return withFileLock(sessionID, () => writeUnlocked(sessionID, meta))
        } catch (error) {
          if (error instanceof StoreLockError) return { ok: false, reason: error.reason }
          return { ok: false, reason: "state: failed" }
        }
      })
    },
    update<T>(sessionID: string, fn: (current: SessionMeta | null) => { next: SessionMeta; result: T }): Promise<UpdateResult<T>> {
      return enqueue(sessionID, async () => {
        try {
          ensureDir()
        } catch {
          return { ok: false, reason: "state: directory unavailable" }
        }
        try {
          return withFileLock<UpdateResult<T>>(sessionID, () => {
            const current = readUnlocked(sessionID)
            if (!current.ok) return { ok: false, reason: current.reason }
            const { next, result } = fn(current.value)
            const saved = writeUnlocked(sessionID, next)
            if (!saved.ok) return { ok: false, reason: saved.reason }
            return { ok: true, value: result }
          })
        } catch (error) {
          if (error instanceof StoreLockError) return { ok: false, reason: error.reason }
          return { ok: false, reason: "state: failed" }
        }
      })
    },
    async removeOwned(sessionID) {
      try {
        rmSync(paths(sessionID).file, { force: true })
      } catch {
        // Session lifecycle cleanup is best effort; stale metadata is allowed.
      }
    },
  }
}
