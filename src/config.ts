import { lstatSync, readFileSync, statSync } from "node:fs"
import type { Stats } from "node:fs"
import { isAbsolute, join } from "node:path"
import { parseAllDocuments } from "yaml"

export const CONFIG_MAX_BYTES = 64 * 1024

export type ReviewConfig = {
  enabled: boolean
  intervalMessages: number
  maxReminders: number
  backoffMultiplier: number
}

export type HistoricalConfig = {
  readTitles: boolean
  renameTitles: boolean
  readTranscript: boolean
}

export type StmConfig = {
  review: ReviewConfig
  historical: HistoricalConfig
}

export const DEFAULT_CONFIG: Readonly<StmConfig> = Object.freeze({
  review: Object.freeze<ReviewConfig>({ enabled: true, intervalMessages: 20, maxReminders: 3, backoffMultiplier: 2 }),
  historical: Object.freeze<HistoricalConfig>({ readTitles: false, renameTitles: false, readTranscript: false }),
})

function freshDefaults(): StmConfig {
  return {
    review: { ...DEFAULT_CONFIG.review },
    historical: { ...DEFAULT_CONFIG.historical },
  }
}

export type ConfigResult =
  | { ok: true; config: StmConfig; path: string | null }
  | { ok: false; reason: string }

export function resolveConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg !== undefined && xdg.length > 0 && isAbsolute(xdg) ? xdg : join(home, ".config")
  return join(base, "opencode", "opencode-stm", "config.yaml")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const TOP_KEYS = new Set(["review", "historical"])
const REVIEW_KEYS = new Set(["enabled", "intervalMessages", "maxReminders", "backoffMultiplier"])
const HISTORICAL_KEYS = new Set(["readTitles", "renameTitles", "readTranscript"])

function findUnknownKey(input: Record<string, unknown>, allowed: ReadonlySet<string>, prefix: string): string | null {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return `config: unknown key ${prefix}${key}`
  }
  return null
}

function readBoolean(input: Record<string, unknown>, key: string, prefix: string, fallback: boolean): boolean | string {
  const value = input[key]
  if (value === undefined) return fallback
  if (typeof value !== "boolean") return `config: ${prefix}${key} must be a boolean`
  return value
}

function readInteger(
  input: Record<string, unknown>,
  key: string,
  prefix: string,
  min: number,
  max: number,
  fallback: number,
): number | string {
  const value = input[key]
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return `config: ${prefix}${key} must be an integer between ${min} and ${max}`
  }
  return value
}

export function parseConfigText(text: string): ConfigResult {
  let documents
  try {
    documents = parseAllDocuments(text, { uniqueKeys: true, version: "1.2", strict: true })
  } catch {
    return { ok: false, reason: "config: invalid YAML" }
  }
  if (documents.length > 1) return { ok: false, reason: "config: multiple YAML documents are not supported" }
  const document = documents[0]
  if (document === undefined) return { ok: true, config: freshDefaults(), path: null }
  if (document.errors.length > 0) return { ok: false, reason: "config: invalid YAML" }
  let raw: unknown
  try {
    // maxAliasCount 0 disallows all alias nodes; it is a toJS option, not a parse option.
    raw = document.toJS({ maxAliasCount: 0 })
  } catch {
    return { ok: false, reason: "config: aliases are not supported" }
  }
  if (raw === null || raw === undefined) return { ok: true, config: freshDefaults(), path: null }
  if (!isPlainObject(raw)) return { ok: false, reason: "config: top level must be a mapping" }
  const topError = findUnknownKey(raw, TOP_KEYS, "")
  if (topError !== null) return { ok: false, reason: topError }

  const review: ReviewConfig = { ...DEFAULT_CONFIG.review }
  if (raw.review !== undefined) {
    if (!isPlainObject(raw.review)) return { ok: false, reason: "config: review must be a mapping" }
    const error = findUnknownKey(raw.review, REVIEW_KEYS, "review.")
    if (error !== null) return { ok: false, reason: error }
    const enabled = readBoolean(raw.review, "enabled", "review.", review.enabled)
    if (typeof enabled === "string") return { ok: false, reason: enabled }
    const intervalMessages = readInteger(raw.review, "intervalMessages", "review.", 1, 10000, review.intervalMessages)
    if (typeof intervalMessages === "string") return { ok: false, reason: intervalMessages }
    const maxReminders = readInteger(raw.review, "maxReminders", "review.", 1, 10, review.maxReminders)
    if (typeof maxReminders === "string") return { ok: false, reason: maxReminders }
    const backoffMultiplier = readInteger(raw.review, "backoffMultiplier", "review.", 1, 10, review.backoffMultiplier)
    if (typeof backoffMultiplier === "string") return { ok: false, reason: backoffMultiplier }
    review.enabled = enabled
    review.intervalMessages = intervalMessages
    review.maxReminders = maxReminders
    review.backoffMultiplier = backoffMultiplier
  }

  const historical: HistoricalConfig = { ...DEFAULT_CONFIG.historical }
  if (raw.historical !== undefined) {
    if (!isPlainObject(raw.historical)) return { ok: false, reason: "config: historical must be a mapping" }
    const error = findUnknownKey(raw.historical, HISTORICAL_KEYS, "historical.")
    if (error !== null) return { ok: false, reason: error }
    const readTitles = readBoolean(raw.historical, "readTitles", "historical.", historical.readTitles)
    if (typeof readTitles === "string") return { ok: false, reason: readTitles }
    const renameTitles = readBoolean(raw.historical, "renameTitles", "historical.", historical.renameTitles)
    if (typeof renameTitles === "string") return { ok: false, reason: renameTitles }
    const readTranscript = readBoolean(raw.historical, "readTranscript", "historical.", historical.readTranscript)
    if (typeof readTranscript === "string") return { ok: false, reason: readTranscript }
    historical.readTitles = readTitles
    historical.renameTitles = renameTitles
    historical.readTranscript = readTranscript
  }

  return { ok: true, config: { review, historical }, path: null }
}

export function loadConfig(env: NodeJS.ProcessEnv, home: string): ConfigResult {
  const path = resolveConfigPath(env, home)
  // lstat distinguishes a truly absent entry from a dangling symlink: statSync
  // reports ENOENT for both, but an existing unusable config must fail closed.
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, config: freshDefaults(), path: null }
    }
    return { ok: false, reason: "config: file status is unreadable" }
  }
  let fileStat: Stats
  try {
    fileStat = statSync(path)
  } catch {
    return { ok: false, reason: "config: file status is unreadable" }
  }
  if (!fileStat.isFile()) return { ok: false, reason: "config: path is not a regular file" }
  const size = fileStat.size
  if (size > CONFIG_MAX_BYTES) return { ok: false, reason: `config: file larger than ${CONFIG_MAX_BYTES} bytes` }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { ok: false, reason: "config: file is unreadable" }
  }
  const parsed = parseConfigText(text)
  return parsed.ok ? { ok: true, config: parsed.config, path } : parsed
}
