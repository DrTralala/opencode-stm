// test/config.test.ts
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CONFIG_MAX_BYTES,
  DEFAULT_CONFIG,
  loadConfig,
  parseConfigText,
  resolveConfigPath,
} from "../src/config.js"

const createdDirs: string[] = []

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stm-config-"))
  createdDirs.push(dir)
  return dir
}

test("missing file returns defaults and a null path", () => {
  const home = tempDir()
  const result = loadConfig({}, home)
  assert.deepEqual(result, { ok: true, config: DEFAULT_CONFIG, path: null })
})

test("partial file fills omitted fields from defaults", () => {
  const result = parseConfigText("review:\n  intervalMessages: 50\n")
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.review.intervalMessages, 50)
  assert.equal(result.config.review.enabled, true)
  assert.equal(result.config.review.maxReminders, DEFAULT_CONFIG.review.maxReminders)
  assert.equal(result.config.historical.readTranscript, false)
})

test("config.example.yaml parses to exactly the defaults", () => {
  const text = readFileSync(new URL("../../config.example.yaml", import.meta.url), "utf8")
  assert.deepEqual(parseConfigText(text), { ok: true, config: DEFAULT_CONFIG, path: null })
})

test("out-of-bounds integer is rejected without echoing the raw value", () => {
  const result = parseConfigText("review:\n  intervalMessages: 99999999\n")
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /review\.intervalMessages/)
  assert.equal(result.reason.includes("99999999"), false)
})

test("duplicate keys are rejected", () => {
  assert.equal(parseConfigText("review:\n  enabled: true\n  enabled: false\n").ok, false)
})

test("aliases are rejected", () => {
  assert.equal(parseConfigText("review: &r\n  enabled: true\nhistorical: *r\n").ok, false)
})

test("multiple documents are rejected", () => {
  assert.equal(
    parseConfigText("review:\n  enabled: true\n---\nreview:\n  enabled: false\n").ok,
    false,
  )
})

test("existing unreadable config disables rather than defaulting", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root: mode 000 does not restrict the owner")
    return
  }
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, "review:\n  enabled: true\n")
  chmodSync(path, 0o000)
  const result = loadConfig({}, home)
  chmodSync(path, 0o600)
  assert.equal(result.ok, false)
})

test("file over 64 KiB is rejected before parsing", () => {
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, "#".repeat(CONFIG_MAX_BYTES + 1))
  assert.equal(loadConfig({}, home).ok, false)
})

test("XDG path resolution ignores unset, empty and relative values", () => {
  assert.equal(
    resolveConfigPath({}, "/home/u"),
    join("/home/u", ".config", "opencode", "opencode-stm", "config.yaml"),
  )
  assert.equal(
    resolveConfigPath({ XDG_CONFIG_HOME: "" }, "/home/u"),
    join("/home/u", ".config", "opencode", "opencode-stm", "config.yaml"),
  )
  assert.equal(
    resolveConfigPath({ XDG_CONFIG_HOME: "relative" }, "/home/u"),
    join("/home/u", ".config", "opencode", "opencode-stm", "config.yaml"),
  )
  assert.equal(
    resolveConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u"),
    join("/xdg", "opencode", "opencode-stm", "config.yaml"),
  )
})

test("empty file returns defaults", () => {
  assert.deepEqual(parseConfigText(""), { ok: true, config: DEFAULT_CONFIG, path: null })
})

test("comments-only file returns defaults", () => {
  assert.deepEqual(parseConfigText("# nothing\n"), { ok: true, config: DEFAULT_CONFIG, path: null })
})

test("unknown top-level key rejected", () => {
  const result = parseConfigText("other: 1\n")
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /other/)
})

test("unknown review key rejected", () => {
  const result = parseConfigText("review:\n  nope: true\n")
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /review\.nope/)
})

test("non-boolean flag rejected", () => {
  const result = parseConfigText("review:\n  enabled: yes\n")
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /review\.enabled/)
})

test("non-integer number rejected", () => {
  assert.equal(parseConfigText("review:\n  maxReminders: 2.5\n").ok, false)
})

test("lower bound accepted", () => {
  const result = parseConfigText(
    "review:\n  intervalMessages: 1\n  maxReminders: 1\n  backoffMultiplier: 1\n",
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.review.intervalMessages, 1)
  assert.equal(result.config.review.maxReminders, 1)
  assert.equal(result.config.review.backoffMultiplier, 1)
})

test("upper bound accepted", () => {
  const result = parseConfigText(
    "review:\n  intervalMessages: 10000\n  maxReminders: 10\n  backoffMultiplier: 10\n",
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.review.intervalMessages, 10000)
  assert.equal(result.config.review.maxReminders, 10)
  assert.equal(result.config.review.backoffMultiplier, 10)
})

test("list top level rejected", () => {
  assert.equal(parseConfigText("- a\n").ok, false)
})

test("existing directory at config path", () => {
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  mkdirSync(path, { recursive: true })
  const result = loadConfig({}, home)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /not a regular file/)
})

test("valid file widens full config", () => {
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(
    path,
    [
      "review:",
      "  enabled: false",
      "  intervalMessages: 5",
      "  maxReminders: 2",
      "  backoffMultiplier: 3",
      "historical:",
      "  readTitles: true",
      "  renameTitles: true",
      "  readTranscript: true",
      "",
    ].join("\n"),
  )
  const result = loadConfig({}, home)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.path, path)
  assert.deepEqual(result.config, {
    review: { enabled: false, intervalMessages: 5, maxReminders: 2, backoffMultiplier: 3 },
    historical: { readTitles: true, renameTitles: true, readTranscript: true },
  })
})

test("mutating a defaulted result does not change later results or the exported defaults", () => {
  const missing = loadConfig({}, tempDir())
  assert.equal(missing.ok, true)
  if (!missing.ok) return
  missing.config.review.enabled = false
  missing.config.review.maxReminders = 99
  missing.config.historical.readTranscript = true

  const empty = parseConfigText("")
  assert.equal(empty.ok, true)
  if (!empty.ok) return
  empty.config.review.enabled = false
  empty.config.historical.readTitles = true

  const laterPartial = parseConfigText("review:\n  intervalMessages: 50\n")
  assert.equal(laterPartial.ok, true)
  if (!laterPartial.ok) return
  assert.equal(laterPartial.config.review.enabled, true)
  assert.equal(laterPartial.config.review.maxReminders, 3)
  assert.equal(laterPartial.config.historical.readTranscript, false)
  assert.equal(laterPartial.config.historical.readTitles, false)

  const laterMissing = loadConfig({}, tempDir())
  assert.deepEqual(laterMissing, { ok: true, config: DEFAULT_CONFIG, path: null })

  assert.equal(DEFAULT_CONFIG.review.enabled, true)
  assert.equal(DEFAULT_CONFIG.review.maxReminders, 3)
  assert.equal(DEFAULT_CONFIG.review.backoffMultiplier, 2)
  assert.equal(DEFAULT_CONFIG.historical.readTitles, false)
  assert.equal(DEFAULT_CONFIG.historical.readTranscript, false)
})

test("exported defaults are deeply frozen", () => {
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.review), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.historical), true)
  const writable = DEFAULT_CONFIG as unknown as {
    review: { enabled: boolean }
    historical: { readTranscript: boolean }
  }
  assert.throws(() => {
    writable.review.enabled = false
  })
  assert.throws(() => {
    writable.historical.readTranscript = true
  })
  assert.equal(DEFAULT_CONFIG.review.enabled, true)
  assert.equal(DEFAULT_CONFIG.historical.readTranscript, false)
})

test("dangling config symlink fails closed without echoing the path", () => {
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  mkdirSync(join(path, ".."), { recursive: true })
  const target = join(home, "missing-target.yaml")
  symlinkSync(target, path, "file")
  const result = loadConfig({}, home)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, "config: file status is unreadable")
  assert.equal(result.reason.includes(target), false)
  assert.equal(result.reason.includes(path), false)
})
