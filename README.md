# AI Usage Status Bar

`AI Usage Status Bar` is a VS Code extension that gives you a live, at-a-glance view of usage limits for multiple AI coding assistants in one place.

It consolidates quota status for `Codex`, `Claude`, `Copilot`, and `Gemini` into a single workflow: status bar summaries for quick checks and a sidebar panel for deeper visibility and control.

## What This Extension Solves

When you use more than one AI assistant, usage and reset information is scattered across different tools and auth flows. This extension centralizes those signals so you can:

- quickly see remaining usage without context switching
- detect low-quota situations before a session is interrupted
- refresh specific providers on demand
- control what appears in the status bar

## Core Capabilities

- Multi-provider usage tracking in the VS Code status bar
  - Codex
  - Claude
  - Copilot
  - Gemini
- Sidebar panel (`AI Usage`) for:
  - full refresh
  - per-provider refresh
  - provider visibility toggles
  - Gemini model-group toggles (`Pro`, `Flash`, `Flash Lite`)
- Fixed 60-second auto refresh
- Detailed diagnostics via the `AI Usage` output channel
- Language support for the sidebar panel:
  - `ko`, `en`, `ja`, `zh-cn`, `zh-tw`, `fr`, `de`, `es`, `pt`, `ru`, `it`, `tr`, `pl`, `nl`, `vi`, `id`

## Provider Data Flow

### Codex

- Source mode options:
  - `auto` (command first, then session-log fallback)
  - `command`
  - `sessionLog`

### Claude

- Priority:
  1. OAuth usage API
  2. optional command fallback
  3. local session rate-limit fallback
- Includes resilience for transient OAuth failures and no-data cases.

### Copilot

- Priority:
  1. GitHub auth session + Copilot API
  2. optional command fallback
- Uses a minimal sign-in prompt strategy to avoid repeated interruptions.

### Gemini

- Uses OAuth credentials from local Gemini auth data.
- Handles token refresh and quota retrieval across Code Assist endpoints.
- Supports model-grouped display (`Pro` / `Flash` / `Flash Lite`) and per-group visibility control.

## UX and Behavior Notes

- Status bar text is always rendered in English for consistency.
- Sidebar language is configurable via `aiUsage.language`.
- If VS Code rejects writes for some `geminiUsage.*` settings, extension fallback state keeps UI behavior consistent.

## Security Notes

- Do not hardcode secrets (OAuth IDs/secrets, tokens) in source.
- Use local credential files or environment variables.
- Validate logs and diffs before pushing.

## License

[MIT](./LICENSE)
