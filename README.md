# opencode-stm

A session title manager for OpenCode, driven by the agent already working in the conversation.

## Status

Version 0.3.0. Historical transcript retrieval returns each bounded chunk directly in its tool result, so the text is stored in the session history like any other result. The 0.2.1 deferred-delivery machinery — the pending-chunk queue, the 60-second expiry, the acknowledgement correlation and the outgoing-request replay — is removed, and pagination state is metadata-only. `stm_history_review_end` releases that state but does not erase results already returned. Automatic configuration-file creation, the tools, defaults, permissions and title behaviour are otherwise unchanged.

The published 0.2.1 build's validation remains historical and does not cover the 0.3.0 direct-result code. On Node.js 24, its `npm run typecheck` and full test suite (262 tests) passed against the OpenCode 1.18.35 SDK, and live loopback runs of the production build against fake OpenAI-wire providers recorded: Responses wire 33 assertions in the plugin-only phase and 35 with an observer wrapper, chat-completions 46 assertions, and the pinned DCP 3.2.0 plugin in both orders 23 assertions each; all passed. All runs used isolated homes and loopback fake providers only. The direct-result code is covered by the fake SDK only: `npm run typecheck` passes and the full test suite (275 tests) passes, with no live-wire or paid-provider validation.

Compatibility is claimed only for what the 0.2.1 loopback validation exercised: OpenCode 1.18.35 with chat-completions-style and OpenAI Responses-style provider wire formats against loopback fake providers. That evidence predates and does not cover the 0.3.0 direct-result code, for which no provider-wire compatibility is claimed. No paid provider call was made, so the real OpenAI endpoint's exact handling remains unverified and no conclusion is extrapolated to Anthropic; no claim is made for other OpenCode versions, Anthropic, paid provider calls, or prompt-cache and billing behaviour.

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

It is not a session-deletion tool and not an automatic bulk-audit service. The design uses OpenCode's SDK without a separate title-generation model or idle background model calls.

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

OpenCode 1.18.35 caches npm plugin installations and may reuse the cached `@latest` package instead of checking the registry on every restart, so `@latest` does not guarantee that a newly published version is picked up on the next restart. Pinning an explicit version (for example `opencode-stm@0.3.0`) is the cache-independent option when a specific release is required.

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
  enabled: true
  intervalMessages: 20
  maxReminders: 3
  backoffMultiplier: 2
historical:
  readTitles: false
  renameTitles: false
  readTranscript: false
```

| Setting | Default | Purpose |
| --- | --- | --- |
| `review.enabled` | `true` | Periodic title reviews for root sessions |
| `review.intervalMessages` | `20` | Eligible messages before the first reminder |
| `review.maxReminders` | `3` | Maximum reminders per review |
| `review.backoffMultiplier` | `2` | Multiplier between reminder thresholds |
| `historical.readTitles` | `false` | Exposes `stm_history_title_read` |
| `historical.renameTitles` | `false` | Exposes `stm_history_title_rename` |
| `historical.readTranscript` | `false` | Exposes `stm_history_transcript` and `stm_history_review_end` |

Startup bootstrap behaviour:

- An existing configuration file is never overwritten: it is preserved byte-for-byte, including empty, invalid and dangling-symlink entries. An existing invalid or unreadable file still disables the plugin (see Setup for the diagnostic detail).
- The generated file contains only the defaults above, so no additional tools or permissions become active: the three current-session tools are exposed as before and the historical tools remain disabled by default.
- A missing file that cannot be created (for example an unwritable destination) or an unusable packaged template disables the plugin with a single diagnostic that contains no raw paths or file contents; there is no fallback to in-memory defaults.
- If the configuration file is deleted, the next startup regenerates it from the packaged template.

Configuration is read once at startup; restart OpenCode after any change. Tool definitions are fixed for the lifetime of the instance. Local state is stored under `$XDG_STATE_HOME/opencode-stm/` (or `~/.local/state/opencode-stm/`) using hashed session identifiers as filenames.

## Behaviour and controls

- Reminders anchor to the most recent eligible message and recur at cumulative thresholds (20, 60, 140 eligible messages by default). The agent resolves each review with `stm_title_review` (`keep` or `rename`), which asks for permission first.
- Locking is conservative: a session whose first observed title is not the native default is locked because its provenance is unknown, and a title change the plugin cannot attribute to its own verified write — including changes made by OpenCode's own auto-titling — locks the session and stops automatic injections. These comparisons are not a background watcher: the title is checked on first observation, before anchoring a new reminder, before replaying an unresolved review's reminders on each outgoing request, and when applying a keep/rename decision. Between those points the plugin does not watch for title changes. An explicit unlock (`stm_title_lock` with `locked: false`) opts the session back in.
- Title writes have no compare-and-swap. The plugin re-checks the title immediately before writing and reads back after, but it cannot guarantee conflict detection: a manual edit that lands between the pre-write check and the write can be overwritten while the write reports success. Detected mismatches produce `conflict` or `uncertain` results, and the plugin never retries a failed or uncertain write automatically.

## Historical access (opt-in)

All historical tools are disabled by default. Each flag independently exposes its own tool; enabling a flag never exposes the other tools. Enabling `historical.readTranscript` sends selected historical transcript content to the active model provider.

The flags do not grant user authorisation and do not override OpenCode permission prompts: every mutating action and every historical read asks through the normal allow/ask/deny policy. Note that headless invocations such as `opencode run` cannot be assumed to present an interactive permission prompt.

Each `stm_history_transcript` call fetches one page of up to 8 messages and returns its bounded chunk directly as the tool result: one JSON metadata header line, a blank line, then the framed untrusted text. The result is at most 16 KiB and 1,999 lines, counting the header, separators, framing and marker escaping. Under OpenCode 1.18.35's default per-result truncation limits (50 KiB and 2,000 lines), every returned result fits the predicate; late message transformations such as DCP 3.2.0 markers are applied after truncation with no second pass, so they do not cause additional spill. A lower configured host limit can still truncate a result. The first fetch returns the newest page; entries within a page are chronological, and each subsequent page, requested with the issued cursor, is older.

The result is an ordinary stored tool result: OpenCode persists the returned text in the session history, and the result becomes eligible for the model context like any other tool result. Persisted history and model context are separate: compaction and other host context management can drop, prune or summarise a result from later model-context windows without erasing the original stored tool-result text. Each additional retrieved chunk therefore grows context usage and input-token consumption, subject to the host's context management. Nothing forces the agent to review a result in the same turn, and nothing deletes the stored result at turn end; the plugin cannot retract a result it has already returned. `messages` counts the visible text entries completed in the result, so a chunk that ends mid-entry can report 0; `bytes` counts the raw source slice included, including the newline separators between entries. Following the continuation guidance and concatenating the delivered payloads reproduces the joined page exactly after reversing the framing-marker escape, which is deliberately reversible: every literal backslash in the payload is doubled, and a source occurrence of a begin or end frame marker is replaced by `-----\ BEGIN ...` / `-----\ END ...` (one backslash inserted after the leading dashes). Reversing that in one pass — escape tokens first, then doubled backslashes — recovers the source exactly, including payloads that already contain escape-token-like text and chunk cuts that land inside a marker, so the displayed payload differs from the source only by that reversible escape.

The `continuation` field states what to do next: when `complete` is true, stop calling. When the page is partial, call again without a cursor for more of the same page. When the page is exhausted, call again with the returned cursor for the next page; omitting that cursor is rejected. A failed next-page read leaves the issued cursor retryable: retry with the same cursor, and a successful read advances the page exactly once. Pagination state is metadata-only (target, offsets, committed and issued cursors, page number and a page digest; no transcript text) and has no TTL; at most 16 caller bindings exist, and a page that changes under partially consumed offsets fails closed and requires a restart. `stm_history_review_end` releases the caller's binding but does not erase results already returned; a `sensitive` outcome also blocks further transcript reads and renames of that target.

A successful call commits its offsets and detaches the request abort listener before returning, so the host's post-success signal teardown does not invalidate the continuation. An abort during the call, before the commit, discards the fetched text and ends the caller's binding. Continuation is only possible with cursors the plugin issued to that caller and target; the plugin does not follow arbitrary Link URLs.

## Privacy boundaries

Historical access is disabled by default. Transcript review sends selected content to the active model provider as an ordinary tool result: OpenCode persists the returned text in the session history, and the result becomes eligible for the provider context like any other tool result. Later context management, including compaction, can drop, prune or summarise it from the model context without erasing the stored original. This is intended behaviour, not an incidental exposure, and the plugin cannot retract what it has returned.

- Title reminders are injected transiently into the outgoing request and are never persisted to the stored conversation. Transcript results are not transient in that sense: the returned text is the stored tool result itself. This is not an end-to-end non-persistence guarantee, and compaction summaries may retain excerpts of the conversation.
- Provider-side prompt cache and billing effects of the returned text have not been measured; an offline byte-stability check does not cover them.
- The direct-result code is exercised only against the fake SDK. No live-wire run has observed how it presents on the provider wire: the released 0.2.1 loopback evidence (chat-completions-style and OpenAI Responses-style formats, reminder conversion and DCP 3.2.0 in both orders) covered the superseded deferred-delivery design and does not apply to it. Anthropic conversion is not verified, and the real OpenAI endpoint's handling has not been observed (no paid provider calls were made).
- Other plugins that capture or log outgoing messages can record injected reminders and transcript results; observed diagnostic exposure of that kind occurred when the capturing plugin's own debug output was enabled.
- STM's own state files are metadata-only: hashed session identifiers are used as file names, and the stored metadata contains counters, title digests, lock state and raw message and part identifiers used for anchoring and replay protection — no raw titles, no transcript text and no session identifiers in file content. Pagination state is in-memory metadata only. Transcript text lives in the OpenCode session history as the returned tool result, not in STM's files. `stm_history_review_end`, including a sensitive outcome, releases pagination state but cannot erase text already returned or stored.

## Releasing

Publication is automated by `.github/workflows/publish.yml`, which runs on a published, non-prerelease GitHub Release:

1. Bump `version` in `package.json` and both root `version` fields in `package-lock.json`.
2. Commit and push `main`, then create a stable tag named `vX.Y.Z` that matches the package version.
3. Publish the GitHub Release for that tag. A build job checks out the release tag, rejects a tag/version mismatch or an already published version, runs `npm run typecheck` and the full test suite, then packs `opencode-stm-<version>.tgz`; a separate publish job downloads that tarball and runs `npm publish ./release/*.tgz --ignore-scripts --access public` with npm OIDC (`id-token: write`). Prereleases are skipped.

npm trusted publishing must be configured on npmjs.com for the `DrTralala/opencode-stm` repository and the `publish.yml` workflow, with no environment and no stored npm token. The OIDC token exists only in the publish job, which installs no dependencies and runs no package lifecycle scripts; the build job that runs `npm ci`, the tests and the pack has read-only repository permissions. The runner's Node 24 bundles an npm that supports OIDC, so no global npm install is required. After a run, verify the published version, dist-tag and provenance on npm.

## Licence

[MIT](LICENSE).
