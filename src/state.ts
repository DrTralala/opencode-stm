import { createHash, randomUUID } from "node:crypto"
import { chmodSync, closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { isBackgroundAttempt, type BackgroundAttempt } from "./background-state.js"

export const STATE_SCHEMA_VERSION = 2
const LEGACY_STATE_SCHEMA_VERSION = 1
export const FRONTIER_MAX = 64
export const ANCHOR_MAX = 32
const REMOVE_LOCK_RETRY_MS = 10
const REMOVE_LOCK_ATTEMPTS = 50

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
  schemaVersion: typeof STATE_SCHEMA_VERSION
  activity: number
  baselineMessageID: string | null
  frontier: string[]
  review: ReviewState | null
  anchors: AnchorState[]
  locked: boolean
  lockReason: LockReason
  titleDigest: string | null
  backgroundReview: BackgroundAttempt | null
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
    backgroundReview: null,
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
  "backgroundReview",
] as const
const LEGACY_META_KEYS = [
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

type BaseMeta = Omit<SessionMeta, "schemaVersion" | "backgroundReview">

function parseBaseMeta(value: Record<string, unknown>): BaseMeta | null {
  if (!Number.isInteger(value.activity) || (value.activity as number) < 0) return null
  if (!(value.baselineMessageID === null || typeof value.baselineMessageID === "string")) return null
  if (!Array.isArray(value.frontier) || value.frontier.length > FRONTIER_MAX || !value.frontier.every((item) => typeof item === "string")) return null
  if (!(value.review === null || isReviewState(value.review))) return null
  if (!Array.isArray(value.anchors) || value.anchors.length > ANCHOR_MAX || !value.anchors.every(isAnchorState)) return null
  if (typeof value.locked !== "boolean") return null
  if (typeof value.lockReason !== "string" || !LOCK_REASONS.includes(value.lockReason as LockReason)) return null
  if (!(value.titleDigest === null || typeof value.titleDigest === "string")) return null
  return {
    activity: value.activity as number,
    baselineMessageID: value.baselineMessageID as string | null,
    frontier: value.frontier as string[],
    review: value.review as ReviewState | null,
    anchors: value.anchors as AnchorState[],
    locked: value.locked as boolean,
    lockReason: value.lockReason as LockReason,
    titleDigest: value.titleDigest as string | null,
  }
}

export function parseMeta(value: unknown): SessionMeta | null {
  if (!isRecord(value)) return null
  if (value.schemaVersion === LEGACY_STATE_SCHEMA_VERSION) {
    if (!hasOnlyKeys(value, LEGACY_META_KEYS)) return null
    const base = parseBaseMeta(value)
    if (base === null) return null
    return { ...base, schemaVersion: STATE_SCHEMA_VERSION, backgroundReview: null }
  }
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) return null
  if (!hasOnlyKeys(value, META_KEYS)) return null
  const base = parseBaseMeta(value)
  if (base === null) return null
  if (!(value.backgroundReview === null || isBackgroundAttempt(value.backgroundReview))) return null
  return {
    ...base,
    schemaVersion: STATE_SCHEMA_VERSION,
    backgroundReview: value.backgroundReview as BackgroundAttempt | null,
  }
}

export type LoadResult = { ok: true; value: SessionMeta | null } | { ok: false; reason: string }
export type SaveResult = { ok: true } | { ok: false; reason: string }
export type UpdateResult<T> = { ok: true; value: T } | { ok: false; reason: string }
export type PresentUpdateResult<T> =
  | { ok: true; present: true; value: T }
  | { ok: true; present: false }
  | { ok: false; reason: string }
export type StateStoreOptions = { stateDir: string; now?: () => number }

export interface StateStore {
  load(sessionID: string): Promise<LoadResult>
  save(sessionID: string, meta: SessionMeta): Promise<SaveResult>
  update<T>(sessionID: string, fn: (current: SessionMeta | null) => { next: SessionMeta; result: T }): Promise<UpdateResult<T>>
  /**
   * Apply the transition only when metadata exists at write time. The locked
   * read and write do not synthesise a state object when the file is absent, so
   * cleanup cannot publish fallback metadata after deletion. Returns
   * `present: false` when metadata is absent.
   */
  updateIfPresent<T>(
    sessionID: string,
    fn: (current: SessionMeta) => { next: SessionMeta; result: T },
  ): Promise<PresentUpdateResult<T>>
  /**
   * Best-effort lifecycle cleanup. Deletes only while holding the shared file
   * lock. If the lock stays unavailable after bounded retries, metadata is left
   * untouched; no lock owned by another process is reclaimed or unlinked.
   */
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
    // Every normal write passes the same strict parser used on load. This keeps
    // arbitrary attempt values (for example an external failure-code string)
    // from reaching disk and bricking the next load. Validate before creating
    // any temporary file so a rejected write has no filesystem side effect.
    const validated = parseMeta(meta)
    if (validated === null) return { ok: false, reason: "state: invalid metadata" }

    const temp = paths(sessionID).temp()
    try {
      const fd = openSync(temp, "w", 0o600)
      try {
        fchmodSync(fd, 0o600)
        writeSync(fd, `${JSON.stringify(validated)}\n`)
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
    updateIfPresent<T>(
      sessionID: string,
      fn: (current: SessionMeta) => { next: SessionMeta; result: T },
    ): Promise<PresentUpdateResult<T>> {
      return enqueue(sessionID, async () => {
        try {
          ensureDir()
        } catch {
          return { ok: false, reason: "state: directory unavailable" }
        }
        try {
          return withFileLock<PresentUpdateResult<T>>(sessionID, () => {
            const current = readUnlocked(sessionID)
            if (!current.ok) return { ok: false, reason: current.reason }
            if (current.value === null) return { ok: true, present: false }
            const { next, result } = fn(current.value)
            const saved = writeUnlocked(sessionID, next)
            if (!saved.ok) return { ok: false, reason: saved.reason }
            return { ok: true, present: true, value: result }
          })
        } catch (error) {
          if (error instanceof StoreLockError) return { ok: false, reason: error.reason }
          return { ok: false, reason: "state: failed" }
        }
      })
    },
    async removeOwned(sessionID) {
      // Lifecycle cleanup is best effort: delete only while holding the shared
      // lock, retry briefly for a live writer, then leave metadata in place if
      // the lock remains unavailable. Callers revoke mutation authority
      // separately, so retaining metadata is safer than deleting without the
      // cross-process exclusion that protects readers and writers.
      await enqueue(sessionID, async () => {
        try {
          ensureDir()
        } catch {
          return
        }
        for (let attempt = 0; attempt < REMOVE_LOCK_ATTEMPTS; attempt += 1) {
          try {
            withFileLock(sessionID, () => {
              rmSync(paths(sessionID).file, { force: true })
            })
            return
          } catch (error) {
            if (!(error instanceof StoreLockError) || error.reason !== "state: lock contention") {
              return
            }
            if (attempt + 1 < REMOVE_LOCK_ATTEMPTS) {
              await new Promise<void>((resolve) => setTimeout(resolve, REMOVE_LOCK_RETRY_MS))
            }
          }
        }
      })
    },
  }
}
