#!/usr/bin/env node
// Release guard for .github/workflows/publish.yml: the GitHub release tag must
// match the stable package.json version, and that version must not already be
// published on npm. Registry lookup failures other than npm's E404 fail closed.

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

const STABLE_VERSION = /^\d+\.\d+\.\d+$/

function fail(message) {
  console.error(`release check failed: ${message}`)
  process.exit(1)
}

function readManifest() {
  let text
  try {
    text = readFileSync("package.json", "utf8")
  } catch (error) {
    fail(`cannot read package.json: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`cannot parse package.json: ${error.message}`)
  }
}

function lookupNpmVersion(name, version) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const result = spawnSync(npm, ["view", `${name}@${version}`, "version"], { encoding: "utf8" })
  if (result.error) return { kind: "error", detail: result.error.message }
  if (result.status === 0) return { kind: "exists" }
  const stderr = result.stderr ?? ""
  if (/\bE404\b/.test(stderr)) return { kind: "missing" }
  const detail = stderr.trim().split("\n")[0] || `npm view exited with status ${result.status}`
  return { kind: "error", detail }
}

const tag = process.env.RELEASE_TAG
if (tag === undefined || tag === "") fail("RELEASE_TAG is not set")
const manifest = readManifest()
const name = manifest.name
const version = manifest.version
if (typeof name !== "string" || typeof version !== "string") fail("package.json is missing name or version")
if (tag !== `v${version}`) fail(`release tag ${tag} does not match v${version}`)
if (!STABLE_VERSION.test(version)) fail(`package version ${version} is not a stable release`)
const lookup = lookupNpmVersion(name, version)
if (lookup.kind === "exists") fail(`${name}@${version} is already published`)
if (lookup.kind === "error") fail(`registry lookup for ${name}@${version} failed: ${lookup.detail}`)
console.log(`release check passed: ${name}@${version} is unpublished`)
