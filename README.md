# opencode-stm

An OpenCode plugin for session title management, driven by the agent already working in the conversation.

## Status

The implementation and its unit and integration tests exist in this repository, and the prototype gates for OpenCode 1.18.35 have passed (the findings are local and not part of this public repository). An independent validator re-ran the project checks and executed a live production-runtime smoke against OpenCode 1.18.35 using a loopback chat-completions mock provider: `npm run typecheck` and the full test suite passed (218 tests at that validation time; 225 after the final review-fix round, verified with the commands below), all phases of the pairing smoke passed 44/44, and the DCP hook-order checks passed 13/13 in both plugin compositions (order A and order B). Reproduce the project checks with:

```sh
npm test
npm run typecheck
```

Compatibility is claimed only for what that validation exercised: OpenCode 1.18.35 with chat-completions-style providers. No claim is made for other OpenCode versions, other provider wire formats (such as the builtin OpenAI Responses API path or Anthropic), paid provider calls, or prompt-cache and billing behaviour. The package is not published to npm and no release exists.

## Scope

- Agent-callable tools to read, review, rename and lock the current session's title.
- Activity-based reminders for the agent to review the title during long tool-driven turns; the agent keeps the title or renames it through a permission-checked decision.
- Conservative protection for manually edited titles, with an explicit unlock.
- Separately opt-in tools for historical title reads, renames and bounded transcript review.

It is not a session-deletion tool and not an automatic bulk-audit service. The design uses OpenCode's SDK without a separate title-generation model or idle background model calls.

## Setup (from source)

Prerequisite: Node.js 24 or newer and npm. From a source checkout of this repository:

```sh
npm install
npm run build
```

Register the built entry point as a file plugin in the OpenCode configuration (`opencode.json` or `opencode.jsonc` in the project directory or the user config directory), using an absolute path to the built `dist/src/index.js`:

```json
{
  "plugin": ["/absolute/path/to/opencode-stm/dist/src/index.js"]
}
```

Restart OpenCode afterwards. The plugin is loaded once at startup; if its configuration file is present but invalid, the plugin disables itself and prints a single diagnostic: field-level errors name the offending setting, while YAML parse or file access errors stay generic. Raw values are never echoed. There is no npm release; a source checkout with a local build is the only installation method.

## Configuration

Copy `config.example.yaml` to `$XDG_CONFIG_HOME/opencode/opencode-stm/config.yaml` (or `~/.config/opencode/opencode-stm/config.yaml` when `XDG_CONFIG_HOME` is unset or relative). Every field is optional; omitted fields use the defaults shown in the example:

| Setting | Default | Purpose |
| --- | --- | --- |
| `review.enabled` | `true` | Periodic title reviews for root sessions |
| `review.intervalMessages` | `20` | Eligible messages before the first reminder |
| `review.maxReminders` | `3` | Maximum reminders per review |
| `review.backoffMultiplier` | `2` | Multiplier between reminder thresholds |
| `historical.readTitles` | `false` | Exposes `stm_history_title_read` |
| `historical.renameTitles` | `false` | Exposes `stm_history_title_rename` |
| `historical.readTranscript` | `false` | Exposes `stm_history_transcript` and `stm_history_review_end` |

Configuration is read once at startup; restart OpenCode after any change. Tool definitions are fixed for the lifetime of the instance. Local state is stored under `$XDG_STATE_HOME/opencode-stm/` (or `~/.local/state/opencode-stm/`) using hashed session identifiers as filenames.

## Behaviour and controls

- Reminders anchor to the most recent eligible message and recur at cumulative thresholds (20, 60, 140 eligible messages by default). The agent resolves each review with `stm_title_review` (`keep` or `rename`), which asks for permission first.
- Locking is conservative: a session whose first observed title is not the native default is locked because its provenance is unknown, and a title change the plugin cannot attribute to its own verified write — including changes made by OpenCode's own auto-titling — locks the session and stops automatic injections. These comparisons are not a background watcher: the title is checked on first observation, before anchoring a new reminder, before replaying an unresolved review's reminders on each outgoing request, and when applying a keep/rename decision. Between those points the plugin does not watch for title changes. An explicit unlock (`stm_title_lock` with `locked: false`) opts the session back in.
- Title writes have no compare-and-swap. The plugin re-checks the title immediately before writing and reads back after, but it cannot guarantee conflict detection: a manual edit that lands between the pre-write check and the write can be overwritten while the write reports success. Detected mismatches produce `conflict` or `uncertain` results, and the plugin never retries a failed or uncertain write automatically.

## Historical access (opt-in)

All historical tools are disabled by default. Each flag independently exposes its own tool; enabling a flag never exposes the other tools. Enabling `historical.readTranscript` sends selected historical transcript content to the active model provider.

The flags do not grant user authorisation and do not override OpenCode permission prompts: every mutating action and every historical read asks through the normal allow/ask/deny policy. Note that headless invocations such as `opencode run` cannot be assumed to present an interactive permission prompt.

Transcript review is bounded and one-shot: each call fetches one page of up to 8 messages. The first fetch returns the newest page; entries within a page are chronological, and each subsequent page, requested with the issued cursor, is older. At most one 16 KiB chunk is pending per caller. A chunk is delivered once on the next outgoing request of the requesting session and released afterwards; text beyond one chunk continues from stored offsets on later calls. A successful transcript call commits its chunk before returning: OpenCode 1.18.35 aborts the per-call signal shortly after every successful tool return, and the committed chunk ignores that teardown abort so it remains available to the next request. An abort during the call, before the commit, still discards the fetched text and ends the caller's binding. A pending chunk stops being eligible after 60 seconds, checked lazily on the next queue access rather than by a background timer. An observed expiry fails closed: the undelivered chunk is dropped and further transcript calls for that caller are rejected until `stm_history_review_end` ends the review, because the lost chunk's content cannot be recovered and must not be silently skipped; the restarted review refetches from the first page. Because a real session cancellation immediately after a successful call cannot be distinguished from the host's success teardown, the plugin cannot promise real-time erasure of a committed chunk: it is held in memory only, delivered at most once, and released on delivery, review end, session deletion, disposal or the 60-second sweep. Continuation is only possible with cursors the plugin issued to that caller and target; the plugin does not follow arbitrary Link URLs. Because OpenCode 1.18.35 reuses the same transform hook during compaction without a reliable discriminator, a queued chunk may be consumed by a compaction request; the plugin does not claim a compaction exclusion.

## Privacy boundaries

Historical access is disabled by default. Transcript review sends selected content to the active model provider. Avoiding raw transcript files and tool outputs does **not** guarantee that content cannot appear in model responses, logs or compaction summaries.

- The reminders and transcript chunks are injected transiently into the outgoing request. This is not an end-to-end non-persistence guarantee, and compaction summaries may retain excerpts of the conversation.
- Provider-side prompt cache and billing effects of the injected text have not been measured; an offline byte-stability check does not cover them.
- Conversion of the injected synthetic parts to provider wire formats was verified in the prototype only for chat-completions-style providers; conversions for the builtin OpenAI Responses API path and Anthropic are not verified.
- Other plugins that capture or log outgoing messages can record injected reminders and transcript chunks; observed diagnostic exposure of that kind occurred when the capturing plugin's own debug output was enabled.
- State file names are hashed session identifiers. The stored metadata contains counters, title digests, lock state, and raw message and part identifiers used for anchoring and replay protection — no raw titles, no transcript text, and no session identifiers. Tool results never contain transcript text.

Local design and implementation documents live under ignored `docs/` and are not included in this public repository.

## Licence

[MIT](LICENSE).
