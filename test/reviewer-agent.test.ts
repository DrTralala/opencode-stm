import { test } from "node:test"
import assert from "node:assert/strict"
import type { Hooks } from "@opencode-ai/plugin"
import { registerReviewerAgent, REVIEWER_AGENT_NAME } from "../src/reviewer-agent.js"
import type { ReviewerConfig } from "../src/config.js"

type ConfigInput = Parameters<NonNullable<Hooks["config"]>>[0]

function configFixture(): ConfigInput {
  return {
    agent: {
      [REVIEWER_AGENT_NAME]: {
        description: "user definition",
        mode: "primary",
        model: "stale/provider-model",
        prompt: "user prompt",
        tools: { bash: true, edit: true },
        variant: "stale-variant",
      },
      unrelated: { description: "keep me", mode: "subagent", tools: { bash: true } },
    },
    permission: { edit: "ask", bash: "ask" },
  } as ConfigInput
}

test("registration replaces only the owned agent with an unmodelled hidden deny-all subagent", () => {
  const config = configFixture()
  const unrelated = config.agent?.unrelated
  const permissions = config.permission

  registerReviewerAgent(config, { timeoutSeconds: 120 })

  const reviewer = config.agent?.[REVIEWER_AGENT_NAME] as unknown as Record<string, unknown>
  assert.equal(reviewer.mode, "subagent")
  assert.equal(reviewer.hidden, true)
  assert.equal(reviewer.model, undefined)
  assert.equal(reviewer.variant, undefined)
  assert.deepEqual(reviewer.tools, { "*": false })
  assert.deepEqual(reviewer.permission, { "*": "deny" })
  assert.equal(typeof reviewer.description, "string")
  assert.match(reviewer.description as string, /title review/i)
  assert.equal(typeof reviewer.prompt, "string")
  assert.match(reviewer.prompt as string, /untrusted/i)
  assert.match(reviewer.prompt as string, /exactly one JSON object/i)
  assert.equal(config.agent?.unrelated, unrelated)
  assert.deepEqual(config.permission, permissions)
})

test("registration installs the exact configured model without retaining user overrides", () => {
  const config = configFixture()
  const reviewer: ReviewerConfig = { model: "provider/family/model-id", timeoutSeconds: 10 }

  registerReviewerAgent(config, reviewer)

  assert.equal(config.agent?.[REVIEWER_AGENT_NAME]?.model, "provider/family/model-id")
  assert.equal(config.agent?.[REVIEWER_AGENT_NAME]?.mode, "subagent")
  assert.equal(config.agent?.[REVIEWER_AGENT_NAME]?.hidden, true)
})
