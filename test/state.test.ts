// test/state.test.ts
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
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
import { reserveReview, type BackgroundAttempt } from "../src/background-state.js"

const createdDirs: string[] = []

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stm-state-"))
  createdDirs.push(dir)
  return dir
}

function backgroundAttempt(overrides: Partial<BackgroundAttempt> = {}): BackgroundAttempt {
  return {
    id: "attempt-1",
    reviewID: "review-1",
    ownerID: "owner-1",
    phase: "active",
    titleDigest: hashTitle("Synthetic title"),
    cutoffMessageID: "msg_dispatch",
    activityAtDispatch: 0,
    deadline: 120000,
    childSessionID: null,
    promptMessageID: null,
    stop: "not-started",
    failureCode: null,
    ...overrides,
  }
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

test("schema version 2 starts without a background attempt", () => {
  const meta = initialMeta()
  assert.equal(meta.schemaVersion, 2)
  assert.equal(meta.backgroundReview, null)
  assert.notEqual(parseMeta(meta), null)
})

test("valid version 1 metadata migrates without changing stored values", async () => {
  const dir = tempDir()
  const file = join(dir, `${hashSessionID("ses_1")}.json`)
  const legacy = {
    schemaVersion: 1,
    activity: 37,
    baselineMessageID: "msg_baseline",
    frontier: ["msg_a", "msg_b"],
    review: { id: "review-1", remindersSent: 2, nextTriggerAt: 140 },
    anchors: [
      {
        reviewID: "review-1",
        reminderIndex: 0,
        anchorMessageID: "msg_anchor",
        partID: "stm-reminder-review-1-0",
        obsolete: false,
      },
    ],
    locked: true,
    lockReason: "manual",
    titleDigest: hashTitle("SENSITIVE RAW TITLE"),
  }
  writeFileSync(file, JSON.stringify(legacy))

  const store = createStateStore({ stateDir: dir })
  const loaded = await store.load("ses_1")
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return
  assert.deepEqual(loaded.value, { ...legacy, schemaVersion: 2, backgroundReview: null })
  assert.equal(loaded.value?.activity, 37)
  assert.equal(loaded.value?.locked, true)
  assert.equal(loaded.value?.lockReason, "manual")
  assert.deepEqual(loaded.value?.frontier, ["msg_a", "msg_b"])
  assert.deepEqual(loaded.value?.anchors, legacy.anchors)
  assert.equal(loaded.value?.titleDigest, hashTitle("SENSITIVE RAW TITLE"))

  // Loading performs the in-memory migration only; the next normal write
  // persists schema version 2.
  const onDiskBefore = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion: number }
  assert.equal(onDiskBefore.schemaVersion, 1)

  const updated = await store.update("ses_1", (current) => ({
    next: current ?? initialMeta(),
    result: current,
  }))
  assert.equal(updated.ok, true)
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  assert.equal(onDisk.schemaVersion, 2)
  assert.equal(onDisk.backgroundReview, null)
  assert.equal(onDisk.activity, 37)
  assert.equal(onDisk.baselineMessageID, "msg_baseline")
  assert.deepEqual(onDisk.frontier, ["msg_a", "msg_b"])
  assert.deepEqual(onDisk.review, legacy.review)
  assert.deepEqual(onDisk.anchors, legacy.anchors)
  assert.equal(onDisk.locked, true)
  assert.equal(onDisk.lockReason, "manual")
  assert.equal(onDisk.titleDigest, hashTitle("SENSITIVE RAW TITLE"))
  assert.doesNotMatch(readFileSync(file, "utf8"), /SENSITIVE RAW TITLE/)
})

test("malformed version 1 metadata is rejected", () => {
  const valid = {
    schemaVersion: 1,
    activity: 0,
    baselineMessageID: null,
    frontier: [],
    review: null,
    anchors: [],
    locked: false,
    lockReason: "none",
    titleDigest: null,
  }
  assert.notEqual(parseMeta(valid), null)
  assert.equal(parseMeta({ ...valid, extra: 1 }), null)
  assert.equal(parseMeta({ ...valid, backgroundReview: null }), null)
  assert.equal(parseMeta({ ...valid, activity: -1 }), null)
  assert.equal(parseMeta({ ...valid, review: { id: "review-1", remindersSent: 0 } }), null)
  assert.equal(parseMeta({ ...valid, lockReason: "unknown" }), null)
  const withoutDigest = {
    schemaVersion: valid.schemaVersion,
    activity: valid.activity,
    baselineMessageID: valid.baselineMessageID,
    frontier: valid.frontier,
    review: valid.review,
    anchors: valid.anchors,
    locked: valid.locked,
    lockReason: valid.lockReason,
  }
  assert.equal(parseMeta(withoutDigest), null)
})

test("version 2 requires a valid background attempt value", () => {
  const attempt: BackgroundAttempt = {
    id: "attempt-1",
    reviewID: "review-1",
    ownerID: "owner-1",
    phase: "active",
    titleDigest: hashTitle("Old"),
    cutoffMessageID: "msg_dispatch",
    activityAtDispatch: 20,
    deadline: 120000,
    childSessionID: "ses_child",
    promptMessageID: "msg_prompt",
    stop: "pending",
    failureCode: null,
  }
  const meta = initialMeta()
  const withoutAttempt: Record<string, unknown> = { ...meta }
  delete withoutAttempt.backgroundReview
  assert.equal(parseMeta(withoutAttempt), null)
  assert.notEqual(parseMeta({ ...meta, backgroundReview: attempt }), null)
  assert.equal(parseMeta({ ...meta, backgroundReview: { ...attempt, extra: true } }), null)
  assert.equal(parseMeta({ ...meta, backgroundReview: { ...attempt, failureCode: "RAW_PROVIDER_ERROR" } }), null)
  assert.equal(parseMeta({ ...meta, backgroundReview: { ...attempt, phase: "queued" } }), null)
})

test("background state stores references but no raw title or transcript text", async () => {
  const dir = tempDir()
  const attempt: BackgroundAttempt = {
    id: "attempt-1",
    reviewID: "review-1",
    ownerID: "owner-1",
    phase: "active",
    titleDigest: hashTitle("SENSITIVE RAW TITLE"),
    cutoffMessageID: "msg_dispatch",
    activityAtDispatch: 20,
    deadline: 120000,
    childSessionID: "ses_child",
    promptMessageID: "msg_prompt",
    stop: "pending",
    failureCode: null,
  }
  const meta: SessionMeta = {
    ...initialMeta(),
    activity: 27,
    titleDigest: hashTitle("SENSITIVE RAW TITLE"),
    backgroundReview: attempt,
  }
  const store = createStateStore({ stateDir: dir })
  assert.deepEqual(await store.save("ses_1", meta), { ok: true })
  const text = readFileSync(join(dir, `${hashSessionID("ses_1")}.json`), "utf8")
  assert.match(text, /ses_child/)
  assert.match(text, /msg_prompt/)
  assert.doesNotMatch(text, /SENSITIVE RAW TITLE/)
  assert.doesNotMatch(text, /TRANSCRIPT_SENTINEL/)
})

test("save rejects an invalid attempt before writing and retains existing state", async () => {
  const dir = tempDir()
  const store = createStateStore({ stateDir: dir })
  const valid: SessionMeta = {
    ...initialMeta(),
    activity: 5,
    titleDigest: hashTitle("Synthetic title"),
    review: { id: "review-1", remindersSent: 1, nextTriggerAt: 60 },
  }
  assert.deepEqual(await store.save("ses_1", valid), { ok: true })
  const file = join(dir, `${hashSessionID("ses_1")}.json`)
  const before = readFileSync(file, "utf8")
  const sentinel = "RAW_EXTERNAL_FAILURE_SENTINEL"
  const invalid: SessionMeta = {
    ...valid,
    backgroundReview: backgroundAttempt({ failureCode: sentinel }),
  }

  const rejected = await store.save("ses_1", invalid)
  assert.equal(rejected.ok, false)
  if (rejected.ok) return
  assert.match(rejected.reason, /invalid metadata/)
  assert.doesNotMatch(rejected.reason, /RAW_EXTERNAL_FAILURE_SENTINEL/)

  assert.equal(readFileSync(file, "utf8"), before)
  assert.doesNotMatch(readFileSync(file, "utf8"), /RAW_EXTERNAL_FAILURE_SENTINEL/)
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
  )

  const loaded = await store.load("ses_1")
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return
  assert.deepEqual(loaded.value, valid)

  const fresh = await store.save("ses_2", invalid)
  assert.equal(fresh.ok, false)
  assert.equal(existsSync(join(dir, `${hashSessionID("ses_2")}.json`)), false)
})

test("update rejects an invalid attempt before writing and retains existing state", async () => {
  const dir = tempDir()
  const store = createStateStore({ stateDir: dir })
  const valid: SessionMeta = {
    ...initialMeta(),
    activity: 9,
    titleDigest: hashTitle("Synthetic title"),
    review: { id: "review-1", remindersSent: 2, nextTriggerAt: 140 },
  }
  assert.deepEqual(await store.save("ses_1", valid), { ok: true })
  const file = join(dir, `${hashSessionID("ses_1")}.json`)
  const before = readFileSync(file, "utf8")
  const sentinel = "RAW_EXTERNAL_FAILURE_SENTINEL"

  const rejected = await store.update("ses_1", (current) => ({
    next: {
      ...(current ?? valid),
      backgroundReview: backgroundAttempt({ failureCode: sentinel }),
    },
    result: true,
  }))
  assert.equal(rejected.ok, false)
  if (rejected.ok) return
  assert.match(rejected.reason, /invalid metadata/)
  assert.doesNotMatch(rejected.reason, /RAW_EXTERNAL_FAILURE_SENTINEL/)

  assert.equal(readFileSync(file, "utf8"), before)
  assert.doesNotMatch(readFileSync(file, "utf8"), /RAW_EXTERNAL_FAILURE_SENTINEL/)
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
  )

  const loaded = await store.load("ses_1")
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return
  assert.deepEqual(loaded.value, valid)
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

test("removeOwned serialises behind an in-flight absent-safe update", async () => {
  const dir = tempDir()
  const store = createStateStore({ stateDir: dir })
  assert.deepEqual(await store.save("ses_1", initialMeta()), { ok: true })
  let called = false
  const updating = store.updateIfPresent("ses_1", (current) => {
    called = true
    return { next: { ...current, activity: 4 }, result: true }
  })
  const removing = store.removeOwned("ses_1")
  await Promise.all([updating, removing])
  assert.equal(called, true)
  const loaded = await store.load("ses_1")
  assert.equal(loaded.ok && loaded.value, null)
})

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("removeOwned waits for the shared lock and deletion wins over a concurrent update", async (t) => {
  const dir = tempDir()
  const store = createStateStore({ stateDir: dir })
  await store.save("ses_1", { ...initialMeta(), activity: 1 })

  const ready = join(dir, "child-ready")
  const go = join(dir, "child-go")
  const done = join(dir, "child-done")
  const stateModule = new URL("../src/state.js", import.meta.url).href
  const script = `
import { existsSync, writeFileSync } from "node:fs"
const { createStateStore } = await import(${JSON.stringify(stateModule)})
const store = createStateStore({ stateDir: ${JSON.stringify(dir)} })
writeFileSync(${JSON.stringify(ready)}, "")
while (!existsSync(${JSON.stringify(go)})) await new Promise((resolve) => setTimeout(resolve, 5))
await store.removeOwned("ses_1")
writeFileSync(${JSON.stringify(done)}, "")
`
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "pipe"],
  })
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject)
    child.on("exit", (code) => resolve(code))
  })
  t.after(() => {
    if (child.exitCode === null) child.kill()
  })
  await waitUntil(() => existsSync(ready), "removal child readiness")

  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  const updated = await store.updateIfPresent("ses_1", (current) => {
    writeFileSync(go, "")
    const deadline = Date.now() + 200
    while (!existsSync(done) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 10)
    return { next: { ...current, activity: current.activity + 1 }, result: true }
  })
  assert.deepEqual(updated, { ok: true, present: true, value: true })
  assert.equal(await exited, 0, stderr)
  assert.equal(existsSync(join(dir, `${hashSessionID("ses_1")}.json`)), false)
  assert.equal(existsSync(join(dir, `${hashSessionID("ses_1")}.lock`)), false)
})

test("removeOwned never unlinks an unowned stale lock", async () => {
  const dir = tempDir()
  const store = createStateStore({ stateDir: dir })
  await store.save("ses_1", initialMeta())
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
  const pid = child.pid
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject)
    child.on("exit", () => resolve())
  })
  assert.notEqual(pid, undefined)
  const lock = join(dir, `${hashSessionID("ses_1")}.lock`)
  const stateFile = join(dir, `${hashSessionID("ses_1")}.json`)
  const lockContents = `${pid}\n`
  const stateContents = readFileSync(stateFile, "utf8")
  writeFileSync(lock, lockContents)

  await store.removeOwned("ses_1")

  assert.equal(existsSync(lock), true)
  assert.equal(readFileSync(lock, "utf8"), lockContents)
  assert.equal(existsSync(stateFile), true)
  assert.equal(readFileSync(stateFile, "utf8"), stateContents)
})

test("removeOwned returns within a bound on persistent contention and leaves state untouched", async () => {
  const dir = tempDir()
  const store = createStateStore({ stateDir: dir })
  await store.save("ses_1", { ...initialMeta(), activity: 3 })
  const lock = join(dir, `${hashSessionID("ses_1")}.lock`)
  const stateFile = join(dir, `${hashSessionID("ses_1")}.json`)
  writeFileSync(lock, "held-by-another-process\n")
  const stateContents = readFileSync(stateFile, "utf8")

  const removing = store.removeOwned("ses_1")
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), 3000)
  })
  const outcome = await Promise.race([removing.then(() => "done" as const), timeout])
  if (timer !== undefined) clearTimeout(timer)
  if (outcome === "timeout") {
    // Unblock the legacy infinite retry so the regression can fail instead of
    // hanging the test runner.
    rmSync(lock, { force: true })
    await removing
  }

  assert.equal(outcome, "done")
  assert.equal(existsSync(lock), true)
  assert.equal(existsSync(stateFile), true)
  assert.equal(readFileSync(stateFile, "utf8"), stateContents)
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

test("updateIfPresent on missing state is a no-op and does not create metadata", async () => {
  const dir = tempDir()
  const store = createStateStore({ stateDir: dir })
  let called = false
  const result = await store.updateIfPresent("ses_1", () => {
    called = true
    return { next: initialMeta(), result: true }
  })
  assert.deepEqual(result, { ok: true, present: false })
  assert.equal(called, false)
  assert.equal(existsSync(join(dir, `${hashSessionID("ses_1")}.json`)), false)
})

test("updateIfPresent atomically updates existing state", async () => {
  const dir = tempDir()
  const store = createStateStore({ stateDir: dir })
  assert.deepEqual(await store.save("ses_1", { ...initialMeta(), activity: 2 }), { ok: true })
  const result = await store.updateIfPresent("ses_1", (current) => ({
    next: { ...current, activity: 9 },
    result: "updated",
  }))
  assert.deepEqual(result, { ok: true, present: true, value: "updated" })
  const loaded = await store.load("ses_1")
  assert.equal(loaded.ok && loaded.value?.activity, 9)
})

test("updateIfPresent validates before writing and preserves existing metadata", async () => {
  const dir = tempDir()
  const store = createStateStore({ stateDir: dir })
  const valid: SessionMeta = {
    ...initialMeta(),
    activity: 5,
    titleDigest: hashTitle("Synthetic title"),
    review: { id: "review-1", remindersSent: 1, nextTriggerAt: 60 },
  }
  assert.deepEqual(await store.save("ses_1", valid), { ok: true })
  const file = join(dir, `${hashSessionID("ses_1")}.json`)
  const before = readFileSync(file, "utf8")
  const rejected = await store.updateIfPresent("ses_1", (current) => ({
    next: { ...current, backgroundReview: backgroundAttempt({ failureCode: "RAW_FAILURE_SENTINEL" }) },
    result: true,
  }))
  assert.equal(rejected.ok, false)
  if (rejected.ok) return
  assert.match(rejected.reason, /invalid metadata/)
  assert.equal(readFileSync(file, "utf8"), before)
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

test("separate stores race one reservation and only one queues", async () => {
  const dir = tempDir()
  const setup = createStateStore({ stateDir: dir })
  const meta: SessionMeta = {
    ...initialMeta(),
    activity: 20,
    titleDigest: hashTitle("Synthetic title"),
    review: { id: "review-1", remindersSent: 1, nextTriggerAt: 60 },
  }
  assert.deepEqual(await setup.save("ses_1", meta), { ok: true })

  const attempt: BackgroundAttempt = {
    id: "attempt-1",
    reviewID: "review-1",
    ownerID: "owner-1",
    phase: "active",
    titleDigest: hashTitle("Synthetic title"),
    cutoffMessageID: "msg_dispatch",
    activityAtDispatch: 20,
    deadline: 120000,
    childSessionID: null,
    promptMessageID: null,
    stop: "not-started",
    failureCode: null,
  }

  const contenders = await Promise.all(
    [createStateStore({ stateDir: dir }), createStateStore({ stateDir: dir })].map((store) =>
      store.update("ses_1", (current) => {
        const base = current ?? initialMeta()
        const reserved = reserveReview(base, attempt, false)
        return { next: reserved.next, result: reserved.result }
      }),
    ),
  )

  const statuses = contenders.map((result) => (result.ok ? result.value.status : "error"))
  assert.equal(statuses.filter((status) => status === "queued").length, 1)
  assert.ok(statuses.every((status) => status === "queued" || status === "active" || status === "error"))

  const loaded = await setup.load("ses_1")
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return
  assert.equal(loaded.value?.backgroundReview?.id, "attempt-1")
  assert.equal(loaded.value?.review?.id, "review-1")
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
