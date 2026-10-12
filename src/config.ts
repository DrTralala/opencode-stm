import { randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import type { Stats } from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseAllDocuments } from "yaml"

export const CONFIG_MAX_BYTES = 64 * 1024

// Located relative to the compiled module, never the working directory: from
// dist/src/config.js this resolves to the package root, where the npm file
// allowlist ships config.example.yaml alongside dist/src.
const PACKAGED_TEMPLATE_PATH = fileURLToPath(new URL("../../config.example.yaml", import.meta.url))

const CREATION_FAILED_REASON = "config: user configuration could not be created"

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

type ConfigFileFailure =
  | { kind: "absent" }
  | { kind: "status" }
  | { kind: "not-file" }
  | { kind: "too-large" }
  | { kind: "unreadable" }
  | { kind: "invalid"; reason: string }

type ConfigFileRead =
  | { state: "valid"; config: StmConfig; text: string }
  | { state: "failed"; failure: ConfigFileFailure }

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

function userFailureReason(failure: ConfigFileFailure): string {
  switch (failure.kind) {
    case "absent":
    case "status":
      return "config: file status is unreadable"
    case "not-file":
      return "config: path is not a regular file"
    case "too-large":
      return `config: file larger than ${CONFIG_MAX_BYTES} bytes`
    case "unreadable":
      return "config: file is unreadable"
    case "invalid":
      return failure.reason
  }
}

function templateFailureReason(failure: ConfigFileFailure): string {
  switch (failure.kind) {
    case "absent":
      return "config: packaged template is missing"
    case "status":
    case "unreadable":
      return "config: packaged template is unreadable"
    case "not-file":
      return "config: packaged template is not a regular file"
    case "too-large":
      return `config: packaged template larger than ${CONFIG_MAX_BYTES} bytes`
    case "invalid":
      return "config: packaged template is invalid"
  }
}

// Shared stat/size/parse reader. It returns the validated text alongside the
// parsed configuration so bootstrap writes exactly what it validated instead of
// maintaining a second defaults template.
function readConfigFile(path: string): ConfigFileRead {
  // lstat distinguishes a truly absent entry from a dangling symlink: statSync
  // reports ENOENT for both, but an existing unusable config must fail closed.
  try {
    lstatSync(path)
  } catch (error) {
    return { state: "failed", failure: hasCode(error, "ENOENT") ? { kind: "absent" } : { kind: "status" } }
  }
  let fileStat: Stats
  try {
    fileStat = statSync(path)
  } catch {
    return { state: "failed", failure: { kind: "status" } }
  }
  if (!fileStat.isFile()) return { state: "failed", failure: { kind: "not-file" } }
  if (fileStat.size > CONFIG_MAX_BYTES) return { state: "failed", failure: { kind: "too-large" } }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { state: "failed", failure: { kind: "unreadable" } }
  }
  const parsed = parseConfigText(text)
  if (!parsed.ok) return { state: "failed", failure: { kind: "invalid", reason: parsed.reason } }
  return { state: "valid", config: parsed.config, text }
}

export type EnsureUserConfigResult = { ok: true } | { ok: false; reason: string }

export function ensureUserConfig(packagedPath: string, userPath: string): EnsureUserConfigResult {
  const template = readConfigFile(packagedPath)
  if (template.state === "failed") return { ok: false, reason: templateFailureReason(template.failure) }

  // Any existing final entry, including an empty file or a dangling symlink, is
  // preserved as-is; validating it remains the final reader's responsibility.
  try {
    lstatSync(userPath)
    return { ok: true }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) return { ok: false, reason: "config: file status is unreadable" }
  }

  const directory = dirname(userPath)
  let temporaryPath: string | null = null
  let temporaryCreated = false
  let operationError: unknown
  const recordError = (error: unknown): void => {
    // The first failure is preserved; later cleanup failures only add a failure
    // where none was recorded yet, never replacing the original cause.
    if (operationError === undefined) operationError = error
  }
  try {
    // The temporary name is generated inside the protected block, before any
    // filesystem mutation, so a randomUUID failure also fails closed cleanly.
    temporaryPath = join(directory, `.${basename(userPath)}.${process.pid}.${randomUUID()}.tmp`)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // Exclusive open is the ownership decision: only once it succeeds may this
    // attempt unlink the temporary path, even if the write or flush then fails.
    const descriptor = openSync(temporaryPath, "wx", 0o600)
    temporaryCreated = true
    try {
      writeFileSync(descriptor, template.text, { encoding: "utf8" })
      fsyncSync(descriptor)
    } catch (error) {
      recordError(error)
    }
    try {
      closeSync(descriptor)
    } catch (error) {
      recordError(error)
    }
    // An unflushed, unclosed or failed write is never published; the owned
    // temporary file is removed below and the caller fails closed.
    if (operationError === undefined) {
      try {
        // Hard-link publication cannot overwrite an existing destination,
        // unlike a rename. EEXIST means a concurrent creator won.
        linkSync(temporaryPath, userPath)
      } catch (error) {
        if (!hasCode(error, "EEXIST")) recordError(error)
      }
    }
  } catch (error) {
    // mkdir or openSync failed. If exclusive creation failed (EEXIST) the
    // temporary path belongs to another creator and is never unlinked.
    recordError(error)
  }
  // Only a temporary file this attempt exclusively created is unlinked. Cleanup
  // is always attempted for an owned file, including after a write failure, and
  // a cleanup failure also fails closed.
  if (temporaryCreated && temporaryPath !== null) {
    try {
      unlinkSync(temporaryPath)
    } catch (error) {
      if (!hasCode(error, "ENOENT")) recordError(error)
    }
  }
  return operationError === undefined ? { ok: true } : { ok: false, reason: CREATION_FAILED_REASON }
}

export function loadConfig(env: NodeJS.ProcessEnv, home: string): ConfigResult {
  const path = resolveConfigPath(env, home)
  // The packaged source is validated before any existing user configuration is
  // read, matching the approved debate bootstrap: a broken shipped template
  // disables STM instead of being skipped because a user file happens to exist.
  const ensured = ensureUserConfig(PACKAGED_TEMPLATE_PATH, path)
  if (!ensured.ok) return ensured
  // One read of the final destination as the runtime source, whether it already
  // existed or was just created, including when a concurrent creator won.
  const final = readConfigFile(path)
  if (final.state === "failed") return { ok: false, reason: userFailureReason(final.failure) }
  return { ok: true, config: final.config, path }
}
