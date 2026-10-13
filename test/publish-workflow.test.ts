// test/publish-workflow.test.ts
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1"
const SETUP_NODE_SHA = "949feb2413d6458794dcd2491c4babbbce0c15c1"
const UPLOAD_ARTIFACT_SHA = "cf430e030ddbb5b0abf93d22962f4752f3646cd9"
const DOWNLOAD_ARTIFACT_SHA = "9000827ccba6bdab643e8b6fd33ac0654aef8333"

function workflowSource(): string {
  return readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8")
}

function workflow(): any {
  return parse(workflowSource())
}

function buildJob(): any {
  return workflow().jobs.build
}

function publishJob(): any {
  return workflow().jobs.publish
}

function usesOf(job: any): string[] {
  return job.steps
    .map((step: any) => step.uses)
    .filter((value: unknown) => value !== undefined)
    .map(String)
}

function runSteps(job: any): any[] {
  return job.steps.filter((step: any) => typeof step.run === "string")
}

test("publish workflow runs only for published GitHub releases", () => {
  const parsed = workflow()
  assert.deepEqual(Object.keys(parsed.on), ["release"])
  assert.deepEqual(parsed.on.release.types, ["published"])
})

test("publish workflow skips prerelease events", () => {
  const condition = buildJob().if
  assert.equal(typeof condition, "string")
  assert.match(condition, /!\s*github\.event\.release\.prerelease/)
})

test("build job is read-only and publish job is the only OIDC holder", () => {
  const parsed = workflow()
  assert.equal(parsed.permissions, undefined)
  assert.deepEqual(Object.keys(parsed.jobs), ["build", "publish"])
  assert.deepEqual(buildJob().permissions, { contents: "read" })
  assert.equal(buildJob().permissions["id-token"], undefined)
  assert.deepEqual(publishJob().permissions, { contents: "read", "id-token": "write" })
  assert.doesNotMatch(workflowSource(), /NPM_TOKEN|NODE_AUTH_TOKEN/)
})

test("publish workflow pins every action to a full commit SHA", () => {
  const uses = [...usesOf(buildJob()), ...usesOf(publishJob())]
  assert.ok(uses.length >= 4)
  for (const value of uses) {
    assert.match(value, /^[^@]+@[0-9a-f]{40}$/, `action is not pinned to a full commit SHA: ${value}`)
  }
  assert.ok(uses.includes(`actions/checkout@${CHECKOUT_SHA}`))
  assert.ok(uses.includes(`actions/setup-node@${SETUP_NODE_SHA}`))
  assert.ok(uses.includes(`actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`))
  assert.ok(uses.includes(`actions/download-artifact@${DOWNLOAD_ARTIFACT_SHA}`))
})

test("build job checks out the release tag with Node 24 and caching disabled", () => {
  const job = buildJob()
  assert.equal(job["runs-on"], "ubuntu-latest")
  const checkout = job.steps.find((step: any) => String(step.uses).startsWith("actions/checkout@"))
  assert.equal(checkout.with.ref, "${{ github.event.release.tag_name }}")
  assert.equal(checkout.with["persist-credentials"], false)
  const setup = job.steps.find((step: any) => String(step.uses).startsWith("actions/setup-node@"))
  assert.equal(String(setup.with["node-version"]), "24")
  assert.equal(setup.with["package-manager-cache"], false)
  assert.equal(setup.with.cache, undefined)
  assert.equal(setup.with["registry-url"], undefined)
})

test("build job validates the release version through the environment", () => {
  const job = buildJob()
  const validate = job.steps.find(
    (step: any) => typeof step.run === "string" && step.run.includes("scripts/check-release.mjs"),
  )
  assert.ok(validate, "workflow must run scripts/check-release.mjs")
  assert.equal(validate.env.RELEASE_TAG, "${{ github.event.release.tag_name }}")
  for (const step of [...runSteps(buildJob()), ...runSteps(publishJob())]) {
    assert.doesNotMatch(step.run, /\$\{\{\s*github\.event\.release/, "release values must not be interpolated into shell source")
    assert.doesNotMatch(step.run, /npm install\s+--global/, "no global npm install is required")
  }
})

test("build job runs guard, typecheck, tests then packs a release tarball", () => {
  const job = buildJob()
  const commands = ["node scripts/check-release.mjs", "npm run typecheck", "npm test", "npm pack --pack-destination release"]
  const indexes = commands.map((command) =>
    job.steps.findIndex((step: any) => typeof step.run === "string" && step.run.includes(command)),
  )
  for (const index of indexes) assert.ok(index >= 0, `workflow must run: ${commands[indexes.indexOf(index)]}`)
  for (let i = 1; i < indexes.length; i++) {
    assert.ok(indexes[i]! > indexes[i - 1]!, `${commands[i]} must run after ${commands[i - 1]}`)
  }
})

test("build job uploads exactly one tarball for the publish job", () => {
  const job = buildJob()
  const upload = job.steps.find((step: any) => String(step.uses).startsWith("actions/upload-artifact@"))
  assert.ok(upload, "workflow must upload the package artifact")
  assert.equal(upload.with.name, "npm-package")
  assert.equal(upload.with.path, "release/*.tgz")
  assert.equal(upload.with["if-no-files-found"], "error")
  const packIndex = job.steps.findIndex((step: any) => typeof step.run === "string" && step.run.includes("npm pack"))
  assert.ok(packIndex >= 0, "workflow must pack a tarball")
  assert.ok(job.steps.indexOf(upload) > packIndex, "upload must follow pack")
})

test("publish job depends on the build job and downloads its artifact", () => {
  const job = publishJob()
  assert.deepEqual(job.needs, "build")
  assert.equal(job.steps.length, 3)
  const setup = job.steps.find((step: any) => String(step.uses).startsWith("actions/setup-node@"))
  assert.equal(String(setup.with["node-version"]), "24")
  assert.equal(setup.with["package-manager-cache"], false)
  assert.equal(setup.with["registry-url"], "https://registry.npmjs.org")
  const download = job.steps.find((step: any) => String(step.uses).startsWith("actions/download-artifact@"))
  assert.equal(download.with.name, "npm-package")
  assert.equal(download.with.path, "release")
  assert.equal(download.with["run-id"], undefined)
  assert.equal(download.with.repository, undefined)
  assert.equal(download.with["github-token"], undefined)
})

test("publish job publishes the downloaded tarball with lifecycle scripts disabled", () => {
  const job = publishJob()
  assert.equal(runSteps(job).length, 1)
  const publish = runSteps(job)[0]!
  assert.match(publish.run, /npm publish release\/\*\.tgz/)
  assert.match(publish.run, /--ignore-scripts/)
  assert.match(publish.run, /--access public/)
  assert.ok(!usesOf(job).some((value) => value.startsWith("actions/checkout@")), "publish must not check out source")
  assert.doesNotMatch(publish.run, /npm (ci|install|run|test|pack)\b/, "publish job must not install dependencies or run build steps")
})

type GuardScenario = "missing" | "exists" | "registry-error"

function fakeNpmSource(): string {
  return [
    "#!/usr/bin/env node",
    'const scenario = process.env.FAKE_NPM_SCENARIO;',
    'if (scenario === "exists") { process.stdout.write("0.3.0\\n"); process.exit(0); }',
    'if (scenario === "registry-error") {',
    '  process.stderr.write("npm error code ECONNREFUSED\\nnpm error network request to the registry failed\\n");',
    "  process.exit(1);",
    "}",
    'process.stderr.write("npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/opencode-stm - Not found\\n");',
    "process.exit(1);",
    "",
  ].join("\n")
}

function runReleaseGuard(options: { tag: string; version: string; scenario: GuardScenario }): {
  status: number | null
  stdout: string
  stderr: string
} {
  const dir = mkdtempSync(join(tmpdir(), "stm-release-guard-"))
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "opencode-stm", version: options.version }))
    const binDir = join(dir, "bin")
    mkdirSync(binDir)
    const npmPath = join(binDir, "npm")
    writeFileSync(npmPath, fakeNpmSource())
    chmodSync(npmPath, 0o755)
    const env: NodeJS.ProcessEnv = { ...process.env, FAKE_NPM_SCENARIO: options.scenario, RELEASE_TAG: options.tag }
    env.PATH = [binDir, process.env.PATH].filter((value): value is string => Boolean(value)).join(delimiter)
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/check-release.mjs", import.meta.url))], {
      cwd: dir,
      env,
      encoding: "utf8",
    })
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("release guard accepts a matching unpublished stable version", () => {
  const result = runReleaseGuard({ tag: "v0.3.0", version: "0.3.0", scenario: "missing" })
  assert.equal(result.status, 0, result.stderr)
})

test("release guard rejects a tag that does not match the package version", () => {
  const result = runReleaseGuard({ tag: "v0.2.1", version: "0.3.0", scenario: "missing" })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not match/)
})

test("release guard rejects a prerelease package version", () => {
  const result = runReleaseGuard({ tag: "v0.3.0-beta.1", version: "0.3.0-beta.1", scenario: "missing" })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /stable/)
})

test("release guard fails closed when the registry lookup errors", () => {
  const result = runReleaseGuard({ tag: "v0.3.0", version: "0.3.0", scenario: "registry-error" })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /registry lookup/)
})

test("release guard rejects an already published version", () => {
  const result = runReleaseGuard({ tag: "v0.3.0", version: "0.3.0", scenario: "exists" })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /already published/)
})
