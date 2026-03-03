# AI Usage Status Bar

A VS Code extension that shows usage status for `Codex`, `Claude`, `Copilot`, and `Gemini` directly in the status bar, with a sidebar control panel.

## Install

Install from the VS Code Marketplace:
- https://marketplace.visualstudio.com/items?itemName=duddudcns.codex-usage-statusbar

Or in VS Code:
1. Open Extensions (`Ctrl+Shift+X`)
2. Search `AI Usage Status Bar`
3. Click `Install`

## Features

- 4 provider status items in the status bar:
  - Codex
  - Claude
  - Copilot
  - Gemini
- Sidebar panel (`AI Usage`) with:
  - Full refresh
  - Per-provider refresh
  - Provider visibility toggles
  - Gemini model-group toggles (`Pro`, `Flash`, `Flash Lite`)
- Fixed auto-refresh every 60 seconds
- Detailed diagnostics in the `AI Usage` output channel

## Data Sources

### Codex

- `codexUsage.source=auto`: command first, then session-log fallback
- `codexUsage.source=command`: command only
- `codexUsage.source=sessionLog`: newest `*.jsonl` from `codexUsage.sessionsRoot`

### Claude

Priority order:
1. OAuth usage API (`~/.claude/.credentials.json`)
2. Optional fallback command (`claudeUsage.command`)
3. Local session rate-limit files (`claudeUsage.sessionsRoot`)

Notes:
- Transient OAuth failures can reuse the last successful snapshot.
- In no-data scenarios, usage may be shown as `Full` by design.

### Copilot

Priority order:
1. GitHub auth session + Copilot API
2. Optional fallback command (`copilotUsage.command`)

Auth behavior:
- Silent session lookup first
- If missing, one sign-in prompt per VS Code session
- Required scopes: `read:user`, `user:email`

### Gemini

- OAuth creds: `~/.gemini/oauth_creds.json`
- Token endpoint: `https://oauth2.googleapis.com/token`
- Usage APIs:
  - `v1internal:loadCodeAssist`
  - `v1internal:retrieveUserQuota`

Refresh client candidate order:
1. `client_id/client_secret` in creds file
2. Installed `@google/gemini-cli-core` oauth file
3. Environment-variable defaults

Supported environment variables:
- `GEMINI_CLIENT_ID`
- `GEMINI_CLIENT_SECRET`
- `GEMINI_LEGACY_CLIENT_ID`
- `GEMINI_LEGACY_CLIENT_SECRET`

## Commands

Available in the Command Palette:
- `Codex Usage: Refresh` (`codexUsage.refresh`)
- `Codex Usage: Refresh Gemini` (`codexUsage.refreshGemini`)
- `Codex Usage: Open Output` (`codexUsage.openOutput`)

Status bar items also trigger provider-specific refresh on click.

## Settings

- `aiUsage.language`
- `codexUsage.enabled`
- `codexUsage.source` (`auto | command | sessionLog`)
- `codexUsage.command`
- `codexUsage.commandTimeoutMs`
- `codexUsage.sessionsRoot`
- `claudeUsage.enabled`
- `claudeUsage.sessionsRoot`
- `claudeUsage.command`
- `claudeUsage.commandTimeoutMs`
- `copilotUsage.enabled`
- `copilotUsage.command`
- `copilotUsage.commandTimeoutMs`
- `geminiUsage.enabled`
- `geminiUsage.showPro`
- `geminiUsage.showFlash`
- `geminiUsage.showFlashLite`

## UI and Behavior

- Status bar text is always in English
- Sidebar language is controlled by `aiUsage.language`
- Supported panel languages:
  - `ko`, `en`, `ja`, `zh-cn`, `zh-tw`, `fr`, `de`, `es`, `pt`, `ru`, `it`, `tr`, `pl`, `nl`, `vi`, `id`
- Auto-refresh interval is fixed at 60 seconds
- If VS Code rejects writes for `geminiUsage.*`, extension fallback state is used to keep Gemini toggles applied immediately

## Local Development

```bash
npm install
```

Open this folder in VS Code and press `F5` to launch the Extension Development Host.

## Security Notes

- Do not hardcode OAuth client IDs/secrets in source code.
- Use environment variables or local credential files.
- Before pushing, verify changed files/logs do not include secrets.

## License

[MIT](./LICENSE)
