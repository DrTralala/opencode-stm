# opencode-stm

[![Version](https://img.shields.io/github/v/release/DrTralala/opencode-stm?label=version&color=blue&sort=date&style=flat-square)](https://github.com/DrTralala/opencode-stm/releases/latest)
[![Licence](https://img.shields.io/badge/licence-MIT-green.svg)](LICENSE)

A session-title manager for OpenCode. The agent already working in a conversation can inspect, keep, or rename that session's title; activity-based reminders and access to other sessions are opt-in.

**Quick links:** [Quick start](#quick-start) · [Activity reminders](#activity-based-reminders) · [Background reviewer](#optional-background-reviewer) · [Historical access](#historical-session-access) · [Privacy and safety](#privacy-and-safety) · [Build and validation](#build-validation-and-compatibility)

## Quick start

Use OpenCode 1.18.35 for this setup; the package depends on the 1.18.35 plugin SDK. Compatibility evidence and its limits are described under [Build, validation, and compatibility](#build-validation-and-compatibility).

1. Add the plugin to the `plugin` array in your project or user `opencode.json` / `opencode.jsonc`:

   ```json
   {
     "plugin": ["opencode-stm@latest"]
   }
   ```

   If the array already contains plugins, add this entry without replacing the others. OpenCode resolves and installs npm plugins at startup; you do not need a global npm install. OpenCode 1.18.35 may reuse a cached `@latest` package on restart; pin `opencode-stm@X.Y.Z` (replace with the version you want) when you need a specific release.
2. Restart OpenCode. On first startup STM creates its configuration file if it is missing; it does not overwrite an existing file.
3. In an open conversation, ask your agent: “Use `stm_title_read` first. If this title needs changing, use `stm_title_review` with the current title as `expectedTitle` and ask me before applying a rename.”

The first tool result reports the live title and lock state. `canRename` is advisory, not permission; rename and keep decisions still follow OpenCode's normal permission policy.

## Tools and defaults

These current-session tools are available by default:

- `stm_title_read` reports the caller's live title, lock state, and any pending review.
- `stm_title_review` explicitly keeps the title or renames it. Read first; a rename requires the current `expectedTitle` and a new title.
- `stm_title_lock` locks or unlocks the current session. Locking pauses periodic reviews and prevents renames until a permitted unlock.

Tools operate on the actual caller's session, including a subagent's own session. Automatic reminders are root-session only. The plugin does not start a separate title-generation model or idle model calls in its default mode.

STM reads configuration once at startup. It creates a missing file from the packaged template at `$XDG_CONFIG_HOME/opencode/opencode-stm/config.yaml`, or `~/.config/opencode/opencode-stm/config.yaml` when `XDG_CONFIG_HOME` is unset, empty, or relative. Existing files are never overwritten. An invalid, unreadable, or uncreatable configuration disables the plugin with a diagnostic; restart OpenCode after changing configuration.

## Activity-based reminders

Periodic reminders are disabled by default. To enable them, edit the generated `config.yaml` and set:

```yaml
review:
  enabled: true
```

With defaults, a root session receives its first reminder after 20 eligible messages, then at cumulative thresholds of 60 and 140 (up to three reminders). The active agent handles each review through `stm_title_read` and `stm_title_review`; reminders themselves do not dispatch another model.

STM locks a session when it first encounters an unrecognised, non-default title, or when it detects a title change it cannot attribute to its own verified write. This conservatively protects manual edits and OpenCode auto-titles. To rename a locked session, obtain user-authorised permission to unlock with `stm_title_lock` using the live `expectedTitle`, read the live title and state again, then make a fresh rename without a review ID cleared by unlocking. Automatic reviews never unlock a session, and permission denial means stop.

## Optional background reviewer

**Review input and cost:** STM sends the reviewer a snapshot of retained user/assistant text and compaction summaries visible at its outgoing-message hook—not the full stored history. Tool calls, tool results, and reasoning are excluded, but a summary may describe earlier tool activity. STM adds no size limit, truncation, or extra summarisation; the selected model's context limit applies and an over-limit request fails without a shortened-input retry. This text may contain secrets or personal data, is stored in the child session, and is sent to the selected provider, which may retain it. Dispatch makes an additional model call that consumes provider tokens and may incur cost.

To let STM dispatch due reminders to its built-in reviewer, enable reviews and add a reviewer block:

```yaml
review:
  enabled: true
  reviewer: {}
```

The reviewer is a hidden, tool-disabled subagent registered by STM; no separate agent file or `opencode.json` agent entry is needed. By default it inherits the dispatching conversation's model and variant. Set `review.reviewer.model: provider/model-id` to select an exact model instead; STM does not fall back to another model. `review.reviewer.timeoutSeconds` defaults to 120 (allowed range: 10–600). Restart OpenCode after editing the configuration.

> [!IMPORTANT]
> When upgrading from the earlier external-reviewer configuration, remove `review.reviewer.agent` and the whole `review.reviewer.transcript` block, including `includeToolCalls`, `includeToolResults`, and `maxBytes`. These settings are rejected and disable STM; there is no replacement input-size cap. Put any model choice in `review.reviewer.model`.

Dispatch requires the normal OpenCode permissions. A `queued` result only confirms admission, not completion; after an error or timeout, inspect the live title before retrying. Once dispatch is authorised, STM applies a valid keep/rename decision without a separate conversational confirmation. A plugin restart does not resume result application, and a child session may remain in OpenCode history.

## Historical session access

Historical tools are independently disabled by default. Enable only the access you need:

```yaml
historical:
  readTitles: false
  renameTitles: false
  readTranscript: false
```

- `historical.readTitles` exposes `stm_history_title_read` for another session's title and root/child metadata.
- `historical.renameTitles` exposes `stm_history_title_rename` for explicitly renaming another root session.
- `historical.readTranscript` exposes `stm_history_transcript` and `stm_history_review_end` for reviewing another root session's visible text.

These settings expose tools; they do not grant user authorisation or bypass OpenCode's normal allow/ask/deny policy. Each operation still asks through that policy. Headless commands such as `opencode run` cannot be assumed to present an interactive permission prompt. Historical title reads may inspect root or child metadata, but transcript reads and historical renames accept root sessions only. Use current-session tools for the caller's own title.

Transcript reads return visible user/assistant text only—not reasoning or tool bodies, although a text summary may describe earlier tool activity. Each call returns one bounded chunk (up to 16 KiB and 1,999 lines, from a page of up to eight messages) as framed JSON Lines. Each record has `role`, `messageID`, `partIndex`, `offsetBytes`, `partComplete`, and `text`; `partComplete` marks the end of that source text part, not completion of the assistant's task. Continue with the same `sessionID` and omit `cursor` to let STM resume. Each result is stored in OpenCode session history as an ordinary tool result and may enter model context. A `sensitive` outcome blocks this caller's further transcript reads and historical renames for that target, but does not block separately permitted title-metadata reads or erase text already returned or stored.

## Privacy and safety

- STM's state is stored under `$XDG_STATE_HOME/opencode-stm/`, or `~/.local/state/opencode-stm/` by default. Its files use hashed session IDs as filenames and contain metadata such as counters, title digests, lock state, message identifiers, and background-review IDs—not raw titles or transcript text. This metadata is not described as encrypted.
- Historical transcript results and background-review prompts are different: OpenCode stores them in session history, and the selected model provider receives their content. Ending a historical review, including with `sensitive`, does not delete results already returned or provider-side copies.
- Title writes have no compare-and-swap. STM checks the title before and after a write, but a manual edit between the final check and the write can still be overwritten; a reported success is not conflict-proof.

## Build, validation, and compatibility

For an alternate source-checkout install, use Node.js 24 or newer and npm:

```sh
npm install
npm run build
```

Register the built plugin by absolute path, then restart OpenCode:

```json
{
  "plugin": ["/absolute/path/to/opencode-stm/dist/src/index.js"]
}
```

Run the project checks with:

```sh
npm run typecheck
npm test
```

The current direct-result implementation is covered by fake-SDK tests, not a paid-provider run. The background reviewer also has compiled-plugin loopback coverage against a local OpenCode 1.19.5 host with a fake OpenAI-compatible provider. Earlier OpenCode 1.18.35 loopback checks covered the superseded 0.2.1 deferred-delivery design; they do not establish wire compatibility for the current implementation. No live provider call was made, and these isolated checks do not establish general compatibility with other OpenCode versions, the real OpenAI endpoint, or Anthropic.

Publishing is automated by [`.github/workflows/publish.yml`](.github/workflows/publish.yml) on a published stable GitHub Release. The build job validates the tag/package version, runs the typecheck and tests, and packs the npm package; a separate job publishes with npm OIDC trusted publishing rather than a stored npm token. Verify the published version, dist-tag, and provenance after a release.

## Licence

[MIT](LICENSE).
