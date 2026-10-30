# opencode-stm

A session title manager for OpenCode, driven by the agent already working in the conversation.

## Status

Version 0.5.0. Adds an opt-in background title reviewer: the main agent can dispatch a pending review to a configured OpenCode subagent, which returns a strict keep/rename decision that STM applies without adding the reviewer's text to the parent conversation. Default behaviour is unchanged; reviewer mode requires `review.reviewer.agent`, discloses selected stored transcript text to that agent's provider, and is covered below.

The published 0.2.1 build's validation remains historical and does not cover the newer direct-result code. On Node.js 24, its `npm run typecheck` and full test suite (262 tests) passed against the OpenCode 1.18.35 SDK, and live loopback runs of the production build against fake OpenAI-wire providers recorded: Responses wire 33 assertions in the plugin-only phase and 35 with an observer wrapper, chat-completions 46 assertions, and the pinned DCP 3.2.0 plugin in both orders 23 assertions each; all passed. All runs used isolated homes and loopback fake providers only. The 0.3.0 direct-result code passed typecheck and 275 tests using the fake SDK. The 0.3.1 attributed-history code passed typecheck and 288 tests, including consecutive-user and interrupted-response regressions. The 0.4.0 subagent changes are covered by fake-SDK regression tests for own-session targeting, historical permissions and caller isolation; no new live-wire or paid-provider validation was performed.

The 0.4.1 cursorless-pagination changes have regression coverage for multi-page and partial-page reads, empty pages, explicit-cursor validation and recovery, and failed-read retries. This coverage uses the pager and fake SDK only; no new live-wire or paid-provider validation was performed.

The opt-in background reviewer has additional compiled-plugin loopback coverage against a local OpenCode 1.19.4 host with a fake OpenAI-compatible provider. It exercises asynchronous dispatch, a held reviewer while the parent continues, stored-history cutoff, the configured agent/model/variant, deny-all child permissions, permission denial, duplicate dispatch, unavailable agents and invalid output. This is not a paid-provider run and does not extend the version or wire-format compatibility claims above.

Compatibility is claimed only for what the 0.2.1 loopback validation exercised: OpenCode 1.18.35 with chat-completions-style and OpenAI Responses-style provider wire formats against loopback fake providers. That evidence predates and does not cover the 0.3.x–0.5.x direct-result code or subagent/reviewer access, for which no provider-wire compatibility is claimed. No paid provider call was made, so the real OpenAI endpoint's exact handling remains unverified and no conclusion is extrapolated to Anthropic; no claim is made for other OpenCode versions, Anthropic, paid provider calls, or prompt-cache and billing behaviour.

Reproduce the project checks with:

```sh
npm test
npm run typecheck
```

## Scope

- Agent-callable tools to read, review, rename and lock the current session's title.
- Activity-based reminders for the agent to review the title during long tool-driven turns; the agent keeps the title or renames it through a permission-checked decision.
- Conservative protection for manually edited titles, with an explicit unlock.
- Separately opt-in tools for historical title reads, renames and bounded transcript review.
- An opt-in background title reviewer that delegates a pending review to a configured OpenCode agent.

It is not a session-deletion tool and not an automatic bulk-audit service. Default mode uses OpenCode's SDK without a separate title-generation model or idle background model calls. Reviewer mode adds one bounded reviewer-child call only when the main agent dispatches a due review.

## Setup

### Install as an npm plugin (recommended)

Prerequisite: OpenCode 1.18.35. OpenCode resolves and installs configured npm plugins at startup, so a global npm install is not required.

Add `opencode-stm@latest` to the `plugin` array in the OpenCode configuration (`opencode.json` or `opencode.jsonc` in the project directory or the user config directory):

```json
{
  "plugin": ["opencode-stm@latest"]
}
```

If the configuration already lists plugins, append the package instead of replacing the array.

OpenCode 1.18.35 caches npm plugin installations and may reuse the cached `@latest` package instead of checking the registry on every restart, so `@latest` does not guarantee that a newly published version is picked up on the next restart. Pinning an explicit version (for example `opencode-stm@0.5.0`) is the cache-independent option when a specific release is required.

Restart OpenCode afterwards. On first startup the plugin creates its configuration file if it is missing (see Configuration). The plugin is loaded once at startup; if its configuration file is present but invalid, the plugin disables itself and prints a single diagnostic: field-level errors name the offending setting, while YAML parse or file access errors stay generic. Raw values are never echoed.

### Build from source (alternate)

Prerequisite: Node.js 24 or newer and npm. From a source checkout of this repository:

```sh
npm install
npm run build
```

Register the built entry point as a file plugin in the OpenCode configuration, using an absolute path to the built `dist/src/index.js`:

```json
{
  "plugin": ["/absolute/path/to/opencode-stm/dist/src/index.js"]
}
```

Restart OpenCode afterwards.

## Configuration

On first plugin startup, a missing configuration file is created automatically from the packaged template; no manual copy is needed. The destination is `$XDG_CONFIG_HOME/opencode/opencode-stm/config.yaml`, falling back to `~/.config/opencode/opencode-stm/config.yaml` when `XDG_CONFIG_HOME` is unset, empty or relative. The packaged template is `config.example.yaml` (for a project install, `node_modules/opencode-stm/config.example.yaml`). Every field is optional; omitted fields use the defaults shown here:

```yaml
review:
  enabled: false
  intervalMessages: 20
  maxReminders: 3
  backoffMultiplier: 2
  # reviewer:
  #   agent: session-title-reviewer
  #   timeoutSeconds: 120
  #   transcript:
  #     includeToolCalls: false
  #     includeToolResults: false
  #     maxBytes: 131072
historical:
  readTitles: false
  renameTitles: false
  readTranscript: false
```

| Setting | Default | Purpose |
| --- | --- | --- |
| `review.enabled` | `false` | Periodic title reviews for root sessions |
| `review.intervalMessages` | `20` | Eligible messages before the first reminder |
| `review.maxReminders` | `3` | Maximum reminders per review |
| `review.backoffMultiplier` | `2` | Multiplier between reminder thresholds |
| `review.reviewer` | Absent | Opts into the background reviewer when present |
| `review.reviewer.agent` | Required in reviewer mode | Enabled OpenCode agent name; no implicit fallback |
| `review.reviewer.timeoutSeconds` | `120` | Integer 10–600 covering dispatch acceptance through result handling |
| `review.reviewer.transcript.includeToolCalls` | `false` | Include stored tool names and arguments |
| `review.reviewer.transcript.includeToolResults` | `false` | Include stored textual tool output or error |
| `review.reviewer.transcript.maxBytes` | `131072` | Integer 4096–1048576 limit for the complete reviewer prompt |
| `historical.readTitles` | `false` | Exposes `stm_history_title_read` |
| `historical.renameTitles` | `false` | Exposes `stm_history_title_rename` |
| `historical.readTranscript` | `false` | Exposes `stm_history_transcript` and `stm_history_review_end` |

Periodic reviews are disabled both in generated configurations and when `review.enabled` is omitted, including in empty files. Set `review.enabled: true` to opt in; an existing explicit `true` remains enabled. Manual current-session title tools remain available.

Startup bootstrap behaviour:

- An existing configuration file is never overwritten: it is preserved byte-for-byte, including empty, invalid and dangling-symlink entries. An existing invalid or unreadable file still disables the plugin (see Setup for the diagnostic detail).
- The generated file contains only the defaults above, so no additional tools or permissions become active: the three current-session tools are exposed as before and the historical tools remain disabled by default.
- A missing file that cannot be created (for example an unwritable destination) or an unusable packaged template disables the plugin with a single diagnostic that contains no raw paths or file contents; there is no fallback to in-memory defaults.
- If the configuration file is deleted, the next startup regenerates it from the packaged template.

Configuration is read once at startup; restart OpenCode after any change. Tool definitions are fixed for the lifetime of the instance. Local state is stored under `$XDG_STATE_HOME/opencode-stm/` (or `~/.local/state/opencode-stm/`) using hashed session identifiers as filenames.

## Behaviour and controls

- Root agents and subagents can call the tools. `stm_title_read`, `stm_title_review` and `stm_title_lock` use the actual caller's session, not its parent or root ancestor. A subagent whose title is already non-default must explicitly unlock it before renaming, just like a root session. Automatic reminders remain root-only.
- Reminders anchor to the most recent eligible message and recur at cumulative thresholds (20, 60, 140 eligible messages by default). The agent resolves each review with `stm_title_review` (`keep` or `rename`), which asks for permission first.
- Locking is conservative: a session whose first observed title is not the native default is locked because its provenance is unknown, and a title change the plugin cannot attribute to its own verified write — including changes made by OpenCode's own auto-titling — locks the session and stops automatic injections. These comparisons are not a background watcher: the title is checked on first observation, before anchoring a new reminder, before replaying an unresolved review's reminders on each outgoing request, and when applying a keep/rename decision. Between those points the plugin does not watch for title changes. An explicit unlock (`stm_title_lock` with `locked: false`) opts the session back in.
- Title writes have no compare-and-swap. The plugin re-checks the title immediately before writing and reads back after, but it cannot guarantee conflict detection: a manual edit that lands between the pre-write check and the write can be overwritten while the write reports success. Detected mismatches produce `conflict` or `uncertain` results, and the plugin never retries a failed or uncertain write automatically.

### Background title reviewer (opt-in)

Setting `review.reviewer` exposes `stm_title_review_start` and changes due reminders to ask the main agent to dispatch the pending review and continue its task. Reviews must also be enabled with `review.enabled: true`. The reviewer is an ordinary OpenCode agent defined in the normal configuration; STM does not create, modify or install it:

```json
{
  "agent": {
    "session-title-reviewer": {
      "description": "Reviews stored session text and returns a keep/rename decision.",
      "mode": "subagent",
      "model": "your-provider/your-model",
      "prompt": "Review the supplied transcript and return only the requested JSON decision."
    }
  }
}
```

This example is not active by default. An explicit agent model and configured variant take precedence. Only when the agent defines no model does STM use the dispatching conversation's model, and then use its variant too if the agent defines no variant. Missing, disabled, primary-only or otherwise unusable agents fail closed without substituting another agent or model. Restart OpenCode after configuration changes.

Dispatch and execution:

- The main agent calls `stm_title_review_start` with the pending `reviewID`, the current `expectedTitle`, and optionally `retry: true` after an explicit failure. The call asks normal OpenCode permissions for the dispatch tool, the configured agent (`task`) and the parent review. A denial or abort before acceptance creates no child and discloses no transcript, and the compact result is only a `queued` acknowledgement, not a claim that the review completed.
- The reviewer runs in a stored child session while the parent continues its own turns. Reviewer text, reasoning and its decision are not appended to the parent and do not wake it. STM validates the child's completed visible response as exactly one JSON object, then applies a keep or rename itself.
- The transcript is the complete stored user and visible assistant text before the dispatching assistant message. That in-flight assistant message, its dispatch tool call/result and all later messages are excluded. Defaults exclude tool calls, tool results, reasoning, files and nested child conversations; the `transcript` options can include stored tool calls and textual results. A payload over `maxBytes`, an unreadable page, a missing boundary or an inconsistent cursor fails closed before the child is prompted. STM never silently truncates or labels a partial transcript as complete.
- Decisions are autonomous once dispatch is authorised: there is no separate conversational confirmation of the proposed title. Normal permission rules remain authoritative, including a restrictive parent session; the child receives the parent's non-allow restrictions plus a final deny-all rule and has no shell, edit, nested delegation or STM tools.
- An invalid result, provider error or failure before title application leaves the title unchanged and shows a concise TUI notice when available, otherwise a fixed diagnostic. A timeout can abort an in-flight rename after the host may already have committed the title update, so STM records an uncertain outcome rather than claiming the title was unchanged. After a timeout or other uncertain result, check the live title and reconcile it with the existing explicit title controls; nothing is retried automatically. Repeated ordinary dispatches do not create another worker. A later explicit retry requires `retry: true`; an uncertain title write cannot be retried until the live title and stored state have been reconciled. An unconfirmed child stop blocks replacement.
- After a restart STM does not resume result application. It reconciles stored work lazily on the next root activity or dispatch, within the stored deadline and ownership rules. A crashed plugin cannot guarantee exactly-once cleanup: a raw child session may outlive it, and its history is retained for inspection rather than deleted by STM.

Visibility, disclosure and cost:

- The child is excluded from the normal root-session picker but remains visible through child navigation, explicit session APIs and separate session export. A normal parent export does not include the child transcript.
- Reviewer mode sends the selected stored conversation text to the reviewer agent's provider. That text may contain secrets or personal data; tool exclusion reduces disclosure but does not redact it. The prompt is stored in the child session, and the provider may retain its own copies. The extra child model call consumes provider tokens and may incur cost.
- `session.deleted` revocation and metadata deletion are best effort and ordered before other cleanup, but they do not delete OpenCode's stored child session or provider-side copies. Previously inspected child history remains available.
- OpenCode title writes have no compare-and-swap. A manual title edit between STM's final check and its write can still be overwritten while the guessed write reports success; the existing documented limitation remains.

The plugin performs no global setup changes.

## Historical access (opt-in)

All historical tools are disabled by default. Each flag independently exposes its own tool; enabling a flag never exposes the other tools. Enabling `historical.readTranscript` sends selected historical transcript content to the active model provider.

The flags do not grant user authorisation and do not override OpenCode permission prompts: every mutating action and every historical read asks through the normal allow/ask/deny policy. Note that headless invocations such as `opencode run` cannot be assumed to present an interactive permission prompt.

Subagents use the same opt-in flags and target-scoped permission checks. Historical tools reject self-targets; use current-session tools for the caller's own title. Historical title reads may inspect root or child metadata, but historical transcript reads and renames accept root targets only. Pagination bindings, issued cursors and sensitive blocks belong to the actual caller session: parent and sibling callers do not share them, and a sensitive block is not inherited across the session tree. Each caller must obtain its own permissions and pagination state.

Each `stm_history_transcript` call fetches one page of up to 8 messages and returns its bounded chunk directly as the tool result: one JSON metadata header line, a blank line, then the untrusted frame. The frame starts and ends with fixed marker lines; the `Target session` and `cursor` values in its header are JSON string encoded so arbitrary values stay on one physical line. Between the warning line and the terminating marker the payload is JSON Lines: every line is one complete JSON record and parses directly with `JSON.parse`, with no legacy backslash or frame-marker escaping. The result is at most 16 KiB and 1,999 lines, counting the header, separators, framing and record serialization. Under OpenCode 1.18.35's default per-result truncation limits (50 KiB and 2,000 lines), every returned result fits the predicate; late message transformations such as DCP 3.2.0 markers are applied after truncation with no second pass, so they do not cause additional spill. A lower configured host limit can still truncate a result. The first fetch returns the newest page; entries within a page are chronological, and each subsequent page, requested using STM's saved bookmark, is older.

Each record is a complete, independently parseable line with exactly these fields:

```json
{"role":"user","messageID":"msg_123","partIndex":0,"offsetBytes":0,"partComplete":true,"text":"Please fix this"}
```

- `role` is `user` or `assistant`. Ordinary user messages are retained even when the stored message carries summary metadata such as `{diffs: []}`; only assistant messages with `summary === true` are excluded, alongside non-text, synthetic, ignored and unsupported-role parts. No role is inferred by alternating turns or by reading content, so consecutive user messages and consecutive assistant messages remain distinct records.
- `messageID` and `partIndex` identify the stored message and the index of the text part in that message's original parts array; excluded parts (reasoning, tools, synthetic text) are not renumbered, so indices can have gaps.
- `offsetBytes` is the UTF-8 byte offset of this fragment within that text part, and `partComplete` is true only when the fragment reaches the end of the stored text part. `partComplete` never means the assistant finished its response or task: a session stopped mid-response is returned with the assistant text that was saved, and a session stopped with no assistant text yields no assistant record at all.
- `text` is the exact source slice. Quotes, backslashes, newlines, carriage returns and control characters use JSON string encoding, so a cut can land anywhere and still round-trip through `JSON.parse`.

To reassemble history, parse every payload line, group records by `messageID` and `partIndex`, order them as delivered (each later fragment for an identity continues at the accumulated UTF-8 byte count, and never follows a `partComplete: true` record), and concatenate `text` with no invented separators.

The result is an ordinary stored tool result: OpenCode persists the returned text in the session history, and the result becomes eligible for the model context like any other tool result. Persisted history and model context are separate: compaction and other host context management can drop, prune or summarise a result from later model-context windows without erasing the original stored tool-result text. Each additional retrieved chunk therefore grows context usage and input-token consumption, subject to the host's context management. Nothing forces the agent to review a result in the same turn, and nothing deletes the stored result at turn end; the plugin cannot retract a result it has already returned. `messages` counts the text parts completed in the result (not distinct messages), so a chunk that ends mid-part can report 0; `bytes` counts delivered source-text UTF-8 bytes only, excluding record serialization, framing and separators.

The `continuation` field states what to do next: when `complete` is true, stop calling. Otherwise, call again with only the same `sessionID`: STM remembers the position within a partial page and advances automatically when that page is exhausted. A failed next-page read leaves the saved bookmark retryable: retry without a cursor, and a successful read advances the page exactly once. The optional `cursor` argument remains supported for compatibility, but must match exactly; after a mistyped cursor is rejected, omit it to resume from the saved position. Normal calls do not need to copy opaque cursors or include them in OpenCode's tool-call labels. Pagination state is metadata-only (target, offsets, committed and issued cursors, page number and a page digest; no transcript text) and has no TTL; at most 16 caller bindings exist, and a page that changes under partially consumed offsets fails closed and requires a restart. `stm_history_review_end` releases the caller's binding but does not erase results already returned; a `sensitive` outcome also blocks further transcript reads and renames of that target.

A successful call commits its offsets and detaches the request abort listener before returning, so the host's post-success signal teardown does not invalidate the continuation. An abort during the call, before the commit, discards the fetched text and ends the caller's binding. Continuation uses only bookmarks held by the plugin for that caller and target; explicit foreign cursors are rejected, and the plugin does not follow arbitrary Link URLs.

## Privacy boundaries

Historical access is disabled by default. Transcript review sends selected content to the active model provider as an ordinary tool result: OpenCode persists the returned text in the session history, and the result becomes eligible for the provider context like any other tool result. Later context management, including compaction, can drop, prune or summarise it from the model context without erasing the stored original. This is intended behaviour, not an incidental exposure, and the plugin cannot retract what it has returned.

- Title reminders are injected transiently into the outgoing request and are never persisted to the stored conversation. In reviewer mode, the collected review prompt is persisted in the child session because it is an ordinary child prompt; it is not appended to the parent. Transcript results are not transient: the returned text is the stored tool result itself. This is not an end-to-end non-persistence guarantee, and compaction summaries may retain excerpts of the conversation.
- Provider-side prompt cache and billing effects of the returned text have not been measured; an offline byte-stability check does not cover them.
- The direct-result code is exercised only against the fake SDK. No live-wire run has observed how it presents on the provider wire: the released 0.2.1 loopback evidence (chat-completions-style and OpenAI Responses-style formats, reminder conversion and DCP 3.2.0 in both orders) covered the superseded deferred-delivery design and does not apply to it. The 0.3.1 attributed-history and 0.4.0 subagent changes are covered the same way, by the fake SDK only, with no new live-wire run. Anthropic conversion is not verified, and the real OpenAI endpoint's handling has not been observed (no paid provider calls were made).
- Other plugins that capture or log outgoing messages can record injected reminders and transcript results; observed diagnostic exposure of that kind occurred when the capturing plugin's own debug output was enabled.
- STM's own state files are metadata-only: hashed session identifiers are used as file names, and the stored metadata contains counters, title digests, lock state, raw message and part identifiers used for anchoring and replay protection, plus the background attempt's owner marker, child session ID and prompt message ID when reviewer mode is used. It contains no raw titles or transcript text. Pagination state is in-memory metadata only. Transcript text lives in the OpenCode session history as the returned tool result, not in STM's files. `stm_history_review_end`, including a sensitive outcome, releases pagination state but cannot erase text already returned or stored.

## Releasing

Publication is automated by `.github/workflows/publish.yml`, which runs on a published, non-prerelease GitHub Release:

1. Bump `version` in `package.json` and both root `version` fields in `package-lock.json`.
2. Commit and push `main`, then create a stable tag named `vX.Y.Z` that matches the package version.
3. Publish the GitHub Release for that tag. A build job checks out the release tag, rejects a tag/version mismatch or an already published version, runs `npm run typecheck` and the full test suite, then packs `opencode-stm-<version>.tgz`; a separate publish job downloads that tarball and runs `npm publish ./release/*.tgz --ignore-scripts --access public` with npm OIDC (`id-token: write`). Prereleases are skipped.

npm trusted publishing must be configured on npmjs.com for the `DrTralala/opencode-stm` repository and the `publish.yml` workflow, with no environment and no stored npm token. The OIDC token exists only in the publish job, which installs no dependencies and runs no package lifecycle scripts; the build job that runs `npm ci`, the tests and the pack has read-only repository permissions. The runner's Node 24 bundles an npm that supports OIDC, so no global npm install is required. After a run, verify the published version, dist-tag and provenance on npm.

## Licence

[MIT](LICENSE).
