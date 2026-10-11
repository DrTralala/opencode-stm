// test/state.test.ts
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ANCHOR_MAX,
  FRONTIER_MAX,
  createOperationGuard,
  createStateStore,
  hashSessionID,
  hashTitle,
  initialMeta,
  parseMeta,
  resolveStateDir,
  type SessionMeta,
} from "../src/state.js"

const createdDirs: string[] = []

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stm-state-"))
  createdDirs.push(dir)
  return dir
}

test("save and load round-trip a valid meta", async () => {
  const dir = tempDir()
  const store = createStateStore({ stateDir: dir })
  const meta = { ...initialMeta(), activity: 7, titleDigest: hashTitle("Synthetic title") }
  assert.deepEqual(await store.save("ses_1", meta), { ok: true })
  assert.deepEqual(await store.load("ses_1"), { ok: true, value: meta })
})

test("state directory and file use restrictive modes", async () => {
  const dir = join(tempDir(), "opencode-stm")
  const store = createStateStore({ stateDir: dir })
  await store.save("ses_1", initialMeta())
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  const file = join(dir, `${hashSessionID("ses_1")}.json`)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("malformed JSON and unsupported schema disable loading", async () => {
  const dir = tempDir()
  const file = join(dir, `${hashSessionID("ses_1")}.json`)
  writeFileSync(file, "{not json")
  assert.equal((await createStateStore({ stateDir: dir }).load("ses_1")).ok, false)
  writeFileSync(file, JSON.stringify({ ...initialMeta(), schemaVersion: 99 }))
  assert.equal((await createStateStore({ stateDir: dir }).load("ses_1")).ok, false)
})

test("unknown meta keys are rejected", () => {
  assert.equal(parseMeta({ ...initialMeta(), extra: 1 }), null)
})

test("existing lock file fails closed and is never deleted", async () => {
  const dir = tempDir()
  const lock = join(dir, `${hashSessionID("ses_1")}.lock`)
  writeFileSync(lock, "")
  const result = await createStateStore({ stateDir: dir }).update("ses_1", () => ({
    next: initialMeta(),
    result: true,
  }))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /lock/)
  assert.equal(readFileSync(lock, "utf8"), "")
})

test("failed rename cleans the temporary file", async () => {
  const dir = tempDir()
  // Occupy the final path with a directory so renameSync fails.
  mkdirSync(join(dir, `${hashSessionID("ses_1")}.json`))
  const result = await createStateStore({ stateDir: dir }).save("ses_1", initialMeta())
  assert.equal(result.ok, false)
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
  )
})

test("an unusable state directory fails closed", async () => {
  const base = tempDir()
  // A file where the state directory should be makes creation impossible.
  writeFileSync(join(base, "blocked"), "not a directory")
  const store = createStateStore({ stateDir: join(base, "blocked", "opencode-stm") })
  const saved = await store.save("ses_1", initialMeta())
  assert.equal(saved.ok, false)
  if (saved.ok) return
  assert.match(saved.reason, /directory/)
  assert.equal((await store.load("ses_1")).ok, false)
})

test("concurrent updates serialise and both apply", async () => {
  const store = createStateStore({ stateDir: tempDir() })
  await store.save("ses_1", initialMeta())
  await Promise.all([
    store.update("ses_1", (current) => ({ next: { ...(current ?? initialMeta()), activity: (current?.activity ?? 0) + 1 }, result: null })),
    store.update("ses_1", (current) => ({ next: { ...(current ?? initialMeta()), activity: (current?.activity ?? 0) + 1 }, result: null })),
  ])
  const loaded = await store.load("ses_1")
  assert.equal(loaded.ok && loaded.value?.activity, 2)
})

test("a new store instance reads state written before a restart", async () => {
  const dir = tempDir()
  await createStateStore({ stateDir: dir }).save("ses_1", { ...initialMeta(), activity: 3 })
  const loaded = await createStateStore({ stateDir: dir }).load("ses_1")
  assert.equal(loaded.ok && loaded.value?.activity, 3)
})

test("removeOwned deletes only the hashed state file", async () => {
  const dir = tempDir()
  const store = createStateStore({ stateDir: dir })
  await store.save("ses_1", initialMeta())
  const other = join(dir, "keep-me.txt")
  writeFileSync(other, "keep")
  await store.removeOwned("ses_1")
  const reloaded = await store.load("ses_1")
  assert.equal(reloaded.ok && reloaded.value, null)
  assert.equal(readFileSync(other, "utf8"), "keep")
})

test("state path resolution honours XDG_STATE_HOME", () => {
  assert.equal(resolveStateDir({}, "/home/u"), join("/home/u", ".local", "state", "opencode-stm"))
  assert.equal(resolveStateDir({ XDG_STATE_HOME: "/state" }, "/home/u"), join("/state", "opencode-stm"))
  assert.equal(resolveStateDir({ XDG_STATE_HOME: "rel" }, "/home/u"), join("/home/u", ".local", "state", "opencode-stm"))
})

test("update on missing state receives null", async () => {
  const store = createStateStore({ stateDir: tempDir() })
  let seen: SessionMeta | null | undefined = undefined
  const result = await store.update("ses_1", (current) => {
    seen = current
    return { next: { ...initialMeta(), activity: 1 }, result: true }
  })
  assert.equal(seen, null)
  assert.deepEqual(result, { ok: true, value: true })
})

test("update refuses to write when load is malformed", async () => {
  const dir = tempDir()
  const file = join(dir, `${hashSessionID("ses_1")}.json`)
  writeFileSync(file, "{not json")
  let called = false
  const result = await createStateStore({ stateDir: dir }).update("ses_1", () => {
    called = true
    return { next: { ...initialMeta(), activity: 9 }, result: null }
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /malformed or unsupported/)
  assert.equal(called, false)
  assert.equal(readFileSync(file, "utf8"), "{not json")
})

test("save leaves no lock file behind", async () => {
  const dir = tempDir()
  const store = createStateStore({ stateDir: dir })
  assert.deepEqual(await store.save("ses_1", initialMeta()), { ok: true })
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith(".lock")),
    [],
  )
  assert.equal(statSync(join(dir, `${hashSessionID("ses_1")}.json`)).isFile(), true)
})

test("more than ANCHOR_MAX anchors is rejected on parse", () => {
  const anchor = { reviewID: "rev_1", reminderIndex: 0, anchorMessageID: "msg_1", partID: "part_1", obsolete: false }
  const anchors = Array.from({ length: ANCHOR_MAX }, () => ({ ...anchor }))
  assert.notEqual(parseMeta({ ...initialMeta(), anchors }), null)
  anchors.push({ ...anchor })
  assert.equal(parseMeta({ ...initialMeta(), anchors }), null)
})

test("frontier longer than FRONTIER_MAX is rejected on parse", () => {
  const frontier = Array.from({ length: FRONTIER_MAX }, (_, index) => `msg_${index}`)
  assert.notEqual(parseMeta({ ...initialMeta(), frontier }), null)
  frontier.push("msg_overflow")
  assert.equal(parseMeta({ ...initialMeta(), frontier }), null)
})

test("negative counters rejected", () => {
  assert.equal(parseMeta({ ...initialMeta(), activity: -1 }), null)
  assert.equal(
    parseMeta({ ...initialMeta(), review: { id: "rev_1", remindersSent: -1, nextTriggerAt: 0 } }),
    null,
  )
  assert.equal(
    parseMeta({ ...initialMeta(), review: { id: "rev_1", remindersSent: 0, nextTriggerAt: -1 } }),
    null,
  )
  assert.equal(
    parseMeta({
      ...initialMeta(),
      anchors: [{ reviewID: "rev_1", reminderIndex: -1, anchorMessageID: "msg_1", partID: "part_1", obsolete: false }],
    }),
    null,
  )
})

test("operation guard serialises the same key", async () => {
  const guard = createOperationGuard()
  const order: string[] = []
  let releaseFirst!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const first = guard.run("key", async () => {
    order.push("first-start")
    await gate
    order.push("first-end")
  })
  let secondStarted = false
  const second = guard.run("key", async () => {
    secondStarted = true
    order.push("second-start")
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(secondStarted, false)
  assert.deepEqual(order, ["first-start"])
  releaseFirst()
  await Promise.all([first, second])
  assert.equal(secondStarted, true)
  assert.deepEqual(order, ["first-start", "first-end", "second-start"])
})

test("operation guard runs different keys concurrently", async () => {
  const guard = createOperationGuard()
  let active = 0
  let peak = 0
  let started = 0
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  const runner = async () => {
    active += 1
    peak = Math.max(peak, active)
    started += 1
    await gate
    active -= 1
  }
  const first = guard.run("key-a", runner)
  const second = guard.run("key-b", runner)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(started, 2)
  assert.equal(peak, 2)
  releaseGate()
  await Promise.all([first, second])
  assert.equal(active, 0)
})
