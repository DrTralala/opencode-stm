// test/config.test.ts
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"
import {
  CONFIG_MAX_BYTES,
  DEFAULT_CONFIG,
  ensureUserConfig,
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

function exampleTemplate(): string {
  return readFileSync(new URL("../../config.example.yaml", import.meta.url), "utf8")
}

test("missing file is generated from the packaged template", () => {
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  const result = loadConfig({}, home)
  assert.deepEqual(result, { ok: true, config: DEFAULT_CONFIG, path })
  assert.equal(readFileSync(path, "utf8"), readFileSync(new URL("../../config.example.yaml", import.meta.url), "utf8"))
})

test("missing configuration is generated under an absolute XDG_CONFIG_HOME", () => {
  const home = tempDir()
  const env = { XDG_CONFIG_HOME: tempDir() }
  const path = resolveConfigPath(env, home)
  const result = loadConfig(env, home)
  assert.deepEqual(result, { ok: true, config: DEFAULT_CONFIG, path })
  assert.equal(readFileSync(path, "utf8"), exampleTemplate())
})

test("repeated startup preserves edited bytes and permissions", () => {
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  assert.equal(loadConfig({}, home).ok, true)

  const edited = "review:\n  intervalMessages: 42\n"
  writeFileSync(path, edited)
  chmodSync(path, 0o640)
  const second = loadConfig({}, home)
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.path, path)
  assert.equal(second.config.review.intervalMessages, 42)
  assert.equal(readFileSync(path, "utf8"), edited)
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o640)
})

test("existing empty configuration is preserved unchanged", () => {
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, "")
  const result = loadConfig({}, home)
  assert.deepEqual(result, { ok: true, config: DEFAULT_CONFIG, path })
  assert.equal(readFileSync(path, "utf8"), "")
})

test("existing invalid configuration is unchanged and rejected", () => {
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  mkdirSync(join(path, ".."), { recursive: true })
  const invalid = "review:\n  intervalMessages: not-a-number\n"
  writeFileSync(path, invalid)
  const result = loadConfig({}, home)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason.includes("not-a-number"), false)
  assert.equal(readFileSync(path, "utf8"), invalid)
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

  const laterHome = tempDir()
  const laterMissing = loadConfig({}, laterHome)
  assert.deepEqual(laterMissing, { ok: true, config: DEFAULT_CONFIG, path: resolveConfigPath({}, laterHome) })

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
  assert.equal(lstatSync(path).isSymbolicLink(), true)
  assert.equal(existsSync(target), false)
})

test("an existing valid symlink is read without being replaced", () => {
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  mkdirSync(join(path, ".."), { recursive: true })
  const target = join(home, "real.yaml")
  const text = "review:\n  intervalMessages: 7\n"
  writeFileSync(target, text)
  symlinkSync(target, path, "file")
  const result = loadConfig({}, home)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.path, path)
  assert.equal(result.config.review.intervalMessages, 7)
  assert.equal(lstatSync(path).isSymbolicLink(), true)
  assert.equal(readFileSync(target, "utf8"), text)
})

test("deleting the configuration regenerates it on the next startup", () => {
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  assert.equal(loadConfig({}, home).ok, true)
  rmSync(path)
  const result = loadConfig({}, home)
  assert.deepEqual(result, { ok: true, config: DEFAULT_CONFIG, path })
  assert.equal(readFileSync(path, "utf8"), exampleTemplate())
})

test("generated configuration and its plugin directory are restrictive on Linux", (t) => {
  if (process.platform !== "linux") {
    t.skip("POSIX mode assertions are Linux-only")
    return
  }
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  assert.equal(loadConfig({}, home).ok, true)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700)
})

test("missing packaged template is rejected without creating the destination", () => {
  const directory = tempDir()
  const userPath = join(directory, "user", "config.yaml")
  const result = ensureUserConfig(join(directory, "missing.yaml"), userPath)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason.includes(directory), false)
  assert.equal(existsSync(userPath), false)
})

test("invalid packaged template is rejected without creating the destination", () => {
  const directory = tempDir()
  const packagedPath = join(directory, "template.yaml")
  writeFileSync(packagedPath, "review:\n  intervalMessages: 1\n  intervalMessages: 2\n")
  const userPath = join(directory, "user", "config.yaml")
  const result = ensureUserConfig(packagedPath, userPath)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /packaged template/)
  assert.equal(result.reason.includes("intervalMessages"), false)
  assert.equal(existsSync(userPath), false)
})

test("oversized packaged template is rejected without creating the destination", () => {
  const directory = tempDir()
  const packagedPath = join(directory, "template.yaml")
  writeFileSync(packagedPath, "#".repeat(CONFIG_MAX_BYTES + 1))
  const userPath = join(directory, "user", "config.yaml")
  const result = ensureUserConfig(packagedPath, userPath)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /packaged template/)
  assert.equal(existsSync(userPath), false)
})

test("unwritable destination directory is rejected", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root: mode 0500 does not restrict the owner")
    return
  }
  const directory = tempDir()
  const packagedPath = join(directory, "template.yaml")
  writeFileSync(packagedPath, exampleTemplate())
  const locked = join(directory, "locked")
  mkdirSync(locked, { recursive: true })
  chmodSync(locked, 0o500)
  const userPath = join(locked, "config.yaml")
  try {
    const result = ensureUserConfig(packagedPath, userPath)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason.includes(directory), false)
  } finally {
    chmodSync(locked, 0o700)
  }
  assert.equal(existsSync(userPath), false)
})

test("parent-file destination error is rejected", () => {
  const directory = tempDir()
  const packagedPath = join(directory, "template.yaml")
  writeFileSync(packagedPath, exampleTemplate())
  const blocker = join(directory, "blocker")
  writeFileSync(blocker, "not a directory")
  const result = ensureUserConfig(packagedPath, join(blocker, "nested", "config.yaml"))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason.includes(blocker), false)
  assert.equal(readFileSync(blocker, "utf8"), "not a directory")
})

test("simultaneous child-process creators all see one complete template and leave no temporary files", async () => {
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  const moduleUrl = new URL("../src/config.js", import.meta.url).href
  const script = [
    `import { loadConfig } from ${JSON.stringify(moduleUrl)}`,
    `import { readFileSync } from "node:fs"`,
    `const home = process.argv[1]`,
    `const result = loadConfig({}, home)`,
    `if (!result.ok) { console.error(result.reason); process.exit(1) }`,
    `process.stdout.write(JSON.stringify({ path: result.path, text: readFileSync(result.path, "utf8") }))`,
  ].join("; ")
  const execute = promisify(execFile)
  const runs = await Promise.all(
    Array.from({ length: 4 }, () => execute(process.execPath, ["--input-type=module", "--eval", script, home])),
  )
  const expected = { path, text: exampleTemplate() }
  for (const run of runs) assert.deepEqual(JSON.parse(run.stdout), expected)
  assert.deepEqual(readdirSync(dirname(path)), ["config.yaml"])
})

test("invalid packaged template is rejected even when a valid user file exists", () => {
  const directory = tempDir()
  const packagedPath = join(directory, "template.yaml")
  writeFileSync(packagedPath, "review:\n  intervalMessages: 1\n  intervalMessages: 2\n")
  const userPath = join(directory, "user", "config.yaml")
  const user = "review:\n  intervalMessages: 7\n"
  mkdirSync(dirname(userPath), { recursive: true })
  writeFileSync(userPath, user)
  const result = ensureUserConfig(packagedPath, userPath)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /packaged template/)
  assert.equal(readFileSync(userPath, "utf8"), user)
})

// The production module snapshots its node:fs named imports at first import, so
// fs faults cannot be injected in-process. This child fixture pre-patches the
// CommonJS node:fs exports before the compiled module is imported, making the
// fault deterministic on any supported platform.
function bootstrapFaultScript(): string {
  return `
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const fs = require("node:fs")
const path = require("node:path")
const mode = process.argv[1]
const configUrl = process.argv[2]
const packagedPath = process.argv[3]
const userPath = process.argv[4]
const home = process.argv[5]
const realRead = fs.readFileSync
const realWrite = fs.writeFileSync
if (mode === "template") {
  fs.readFileSync = (target, ...rest) => {
    if (typeof target === "string" && target.endsWith("config.example.yaml")) {
      return "review:\\n  intervalMessages: 1\\n  intervalMessages: 2\\n"
    }
    return realRead(target, ...rest)
  }
} else if (mode === "write") {
  fs.writeFileSync = (target, ...rest) => {
    if (typeof target === "number") {
      const error = new Error("injected write failure")
      error.code = "ENOSPC"
      throw error
    }
    return realWrite(target, ...rest)
  }
} else if (mode === "flush") {
  fs.fsyncSync = () => {
    const error = new Error("injected flush failure")
    error.code = "EIO"
    throw error
  }
} else if (mode === "eexist") {
  const realOpen = fs.openSync
  fs.openSync = (target, ...rest) => {
    // Only the bootstrap temporary file is intercepted; the module loader must
    // keep opening module sources normally.
    if (typeof target === "string" && target.endsWith(".tmp")) {
      globalThis.__stmForeignTemp = target
      realWrite(target, "foreign-temp")
      const error = new Error("injected EEXIST")
      error.code = "EEXIST"
      throw error
    }
    return realOpen(target, ...rest)
  }
} else if (mode === "uuid") {
  const crypto = require("node:crypto")
  crypto.randomUUID = () => {
    const error = new Error("injected uuid failure")
    error.code = "ERR_CRYPTO_RANDOM"
    throw error
  }
} else if (mode === "close") {
  let ownedDescriptor = null
  const realOpen = fs.openSync
  fs.openSync = (target, ...rest) => {
    const descriptor = realOpen(target, ...rest)
    if (typeof target === "string" && target.endsWith(".tmp")) ownedDescriptor = descriptor
    return descriptor
  }
  const realClose = fs.closeSync
  fs.closeSync = (descriptor) => {
    realClose(descriptor)
    if (descriptor === ownedDescriptor) {
      ownedDescriptor = null
      const error = new Error("injected close failure")
      error.code = "EIO"
      throw error
    }
  }
}
const { loadConfig, ensureUserConfig } = await import(configUrl)
const result = mode === "template" ? loadConfig({}, home) : ensureUserConfig(packagedPath, userPath)
const directory = path.dirname(userPath)
let entries = []
try { entries = fs.readdirSync(directory) } catch { entries = [] }
const foreign = globalThis.__stmForeignTemp ?? null
let foreignText = null
if (foreign !== null) { try { foreignText = realRead(foreign, "utf8") } catch { foreignText = null } }
let userText = null
try { userText = realRead(userPath, "utf8") } catch { userText = null }
process.stdout.write(JSON.stringify({ result, entries, foreign, foreignText, userText }))
`
}

type BootstrapFixtureOutput = {
  result: { ok: true } | { ok: false; reason: string }
  entries: string[]
  foreign: string | null
  foreignText: string | null
  userText: string | null
}

async function runBootstrapFixture(
  mode: string,
  packagedPath: string,
  userPath: string,
  home: string,
): Promise<BootstrapFixtureOutput> {
  const moduleUrl = new URL("../src/config.js", import.meta.url).href
  const execute = promisify(execFile)
  const { stdout } = await execute(process.execPath, [
    "--input-type=module",
    "--eval",
    bootstrapFaultScript(),
    mode,
    moduleUrl,
    packagedPath,
    userPath,
    home,
  ])
  return JSON.parse(stdout)
}

test("invalid packaged template disables startup even when the user file is valid", async () => {
  const home = tempDir()
  const path = resolveConfigPath({}, home)
  const user = "review:\n  intervalMessages: 7\n"
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, user)
  const output = await runBootstrapFixture("template", join(home, "unused-template.yaml"), path, home)
  assert.equal(output.result.ok, false)
  if (output.result.ok) return
  assert.match(output.result.reason, /packaged template/)
  assert.equal(output.userText, user)
})

test("a write fault after exclusive creation removes the owned temporary file", async () => {
  const directory = tempDir()
  const packagedPath = join(directory, "template.yaml")
  writeFileSync(packagedPath, exampleTemplate())
  const userPath = join(directory, "user", "config.yaml")
  const output = await runBootstrapFixture("write", packagedPath, userPath, directory)
  assert.deepEqual(output.result, { ok: false, reason: "config: user configuration could not be created" })
  assert.deepEqual(output.entries, [])
  assert.equal(output.userText, null)
})

test("a flush fault after exclusive creation removes the owned temporary file", async () => {
  const directory = tempDir()
  const packagedPath = join(directory, "template.yaml")
  writeFileSync(packagedPath, exampleTemplate())
  const userPath = join(directory, "user", "config.yaml")
  const output = await runBootstrapFixture("flush", packagedPath, userPath, directory)
  assert.deepEqual(output.result, { ok: false, reason: "config: user configuration could not be created" })
  assert.deepEqual(output.entries, [])
  assert.equal(output.userText, null)
})

test("an exclusive-open EEXIST failure preserves a foreign temporary file", async () => {
  const directory = tempDir()
  const packagedPath = join(directory, "template.yaml")
  writeFileSync(packagedPath, exampleTemplate())
  const userPath = join(directory, "user", "config.yaml")
  const output = await runBootstrapFixture("eexist", packagedPath, userPath, directory)
  assert.equal(output.result.ok, false)
  assert.ok(output.foreign)
  assert.match(basename(output.foreign), /^\.config\.yaml\.\d+\.[0-9a-f-]+\.tmp$/)
  assert.equal(output.foreignText, "foreign-temp")
  assert.equal(output.userText, null)
})

test("a randomUUID failure fails closed without creating directories or files", async () => {
  const directory = tempDir()
  const packagedPath = join(directory, "template.yaml")
  writeFileSync(packagedPath, exampleTemplate())
  const userPath = join(directory, "user", "config.yaml")
  const output = await runBootstrapFixture("uuid", packagedPath, userPath, directory)
  assert.deepEqual(output.result, { ok: false, reason: "config: user configuration could not be created" })
  assert.equal(existsSync(dirname(userPath)), false)
  assert.equal(output.userText, null)
})

test("a close fault after exclusive creation cleans up and publishes nothing", async () => {
  const directory = tempDir()
  const packagedPath = join(directory, "template.yaml")
  writeFileSync(packagedPath, exampleTemplate())
  const userPath = join(directory, "user", "config.yaml")
  const output = await runBootstrapFixture("close", packagedPath, userPath, directory)
  assert.deepEqual(output.result, { ok: false, reason: "config: user configuration could not be created" })
  assert.deepEqual(output.entries, [])
  assert.equal(output.userText, null)
})
