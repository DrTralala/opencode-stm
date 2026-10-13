# opencode-stm

A session title manager for OpenCode, driven by the agent already working in the conversation.

## Status

Version 0.2.1. 0.2.1 changes transcript-chunk delivery on the OpenAI Responses wire: the framed chunk is now appended, after the intact acknowledgement, to the outgoing request copy of the matching completed `stm_history_transcript` tool result, so it rides the same provider wire item as every other tool result (`function_call_output`) instead of a synthetic assistant text part that the endpoint may ignore when interleaved. The result is matched by the exact acknowledgement `chunkID` and target session; the stored tool result and its acknowledgement are never modified; and a request whose context does not yet contain a matching completed result retains the chunk for a later eligible request instead of attaching it to a guess. The counts in a queued acknowledgement are not evidence of delivery or model review. 0.2.0's automatic configuration-file creation and the tool behaviour, defaults, permissions and privacy boundaries are otherwise unchanged.

On Node.js 24, `npm run typecheck` and the full test suite (262 tests) passed against the OpenCode 1.18.35 SDK. Live loopback runs of the production build against fake OpenAI-wire providers recorded: Responses wire 33 assertions in the plugin-only phase and 35 with an observer wrapper, chat-completions 46 assertions, and the pinned DCP 3.2.0 plugin in both orders 23 assertions each; all passed. All runs used isolated homes and loopback fake providers only.

Compatibility is claimed only for what that validation exercised: OpenCode 1.18.35 with chat-completions-style and OpenAI Responses-style provider wire formats against loopback fake providers. No paid provider call was made, so the real OpenAI endpoint's exact handling remains unverified and no conclusion is extrapolated to Anthropic; no claim is made for other OpenCode versions, Anthropic, paid provider calls, or prompt-cache and billing behaviour.

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

OpenCode 1.18.35 caches npm plugin installations and may reuse the cached `@latest` package instead of checking the registry on every restart, so `@latest` does not guarantee that a newly published version is picked up on the next restart. Pinning an explicit version (for example `opencode-stm@0.2.1`) is the cache-independent option when a specific release is required.

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

Transcript review is bounded and one-shot: each call fetches one page of up to 8 messages. The first fetch returns the newest page; entries within a page are chronological, and each subsequent page, requested with the issued cursor, is older. At most one 16 KiB chunk is pending per caller. A chunk is delivered once by being appended, after the intact acknowledgement, to the outgoing request copy of the matching completed `stm_history_transcript` tool result, and released afterwards. A result matches only when its leading acknowledgement JSON is this plugin's successful ack for the exact `chunkID` and target session; substring matches, tool position and untyped call ids never match, and several exact matches fail closed. The stored tool result and its acknowledgement are never modified, and the acknowledgement stays byte-identical at the head of the outgoing copy. When a request's context does not yet contain a matching completed result, the chunk stays queued and is retained for a later eligible request instead of being attached to a guess, until it is delivered or the pending chunk expires. The counts in a queued acknowledgement are not evidence of delivery or model review: the framed transcript block must be present in the model's context before conclusions are drawn or a rename is applied. Text beyond one chunk continues from stored offsets on later calls. A successful transcript call commits its chunk before returning: OpenCode 1.18.35 aborts the per-call signal shortly after every successful tool return, and the committed chunk ignores that teardown abort so it remains available to the next request. An abort during the call, before the commit, still discards the fetched text and ends the caller's binding. A pending chunk stops being eligible after 60 seconds, checked lazily on the next queue access rather than by a background timer. An observed expiry fails closed: the undelivered chunk is dropped and further transcript calls for that caller are rejected until `stm_history_review_end` ends the review, because the lost chunk's content cannot be recovered and must not be silently skipped; the restarted review refetches from the first page. Because a real session cancellation immediately after a successful call cannot be distinguished from the host's success teardown, the plugin cannot promise real-time erasure of a committed chunk: it is held in memory only, delivered at most once, and released on delivery, review end, session deletion, disposal or the 60-second sweep. Continuation is only possible with cursors the plugin issued to that caller and target; the plugin does not follow arbitrary Link URLs. Because OpenCode 1.18.35 reuses the same transform hook during compaction without a reliable discriminator, a queued chunk may be consumed by a compaction request; the plugin does not claim a compaction exclusion.

## Privacy boundaries

Historical access is disabled by default. Transcript review sends selected content to the active model provider. Avoiding raw transcript files and stored tool outputs does **not** guarantee that content cannot appear in model responses, logs or compaction summaries: the outgoing request copy of the matching tool result carries the raw delivered chunk.

- The reminders are injected transiently into the outgoing request, and the transcript chunk is appended transiently to the outgoing request copy of the matching transcript tool result; the stored copy is never modified, and neither injection is persisted to the stored conversation. This is not an end-to-end non-persistence guarantee, and compaction summaries may retain excerpts of the conversation.
- Provider-side prompt cache and billing effects of the delivered text have not been measured; an offline byte-stability check does not cover them.
- A transcript chunk rides the same provider wire item as every other tool result (a function call output); current loopback runs on both the chat-completions and OpenAI Responses wire formats confirmed the framed chunk on the matching tool result, with the stored acknowledgement unchanged. Reminder conversion was verified only against chat-completions-style providers and loopback OpenAI Responses mocks; Anthropic conversion is not verified, and the real OpenAI endpoint's handling of the delivered chunk has not been observed (no paid provider calls were made).
- Other plugins that capture or log outgoing messages can record injected reminders and transcript chunks; observed diagnostic exposure of that kind occurred when the capturing plugin's own debug output was enabled.
- State file names are hashed session identifiers. The stored metadata contains counters, title digests, lock state, and raw message and part identifiers used for anchoring and replay protection — no raw titles, no transcript text, and no session identifiers. Stored tool results never contain transcript text; the queued chunk is appended only to the outgoing request copy of the matching tool result.

## Licence

[MIT](LICENSE).
