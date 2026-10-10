# opencode-stm

A planned OpenCode plugin for session title management using the agent already working in the conversation.

## Status

Design stage. This repository currently contains only the project baseline; there is no working plugin, installable package or release yet.

## Planned scope

- Agent-callable tools to read and update the current session's title.
- Configurable, activity-based reminders for the main agent to review the title, including during long tool-driven turns. The agent can rename it or explicitly keep it.
- Protection for manually edited titles and controls to pause automatic reviews.
- Separately opt-in tools for historical title reads, renames and bounded transcript review, configured through `config.yaml`.

The intended design uses OpenCode's SDK without a separate title-generation model or idle background model calls. It is not a session-deletion tool or an automatic bulk-audit service.

## Privacy boundaries

Historical access is planned to be disabled by default. Transcript review would send selected content to the active model provider. Avoiding raw transcript files and tool outputs does **not** guarantee that content cannot appear in model responses, logs or compaction summaries.

Local design and implementation documents live under ignored `docs/` and are not included in this public repository. Compatibility and runtime behaviour have not yet been tested.

## Licence

[MIT](LICENSE).
