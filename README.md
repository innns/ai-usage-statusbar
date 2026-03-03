# AI Usage Status Bar

VS Code extension for showing Codex, Claude, Copilot, and Gemini usage in the
status bar, with a sidebar settings panel.

## What It Shows

- 4 status bar items: Codex, Claude, Copilot, Gemini
- Usage summaries per provider (quota/limits)
- Provider-specific details in tooltip
- Gemini status bar summary includes 3 model groups: `Flash Lite`, `Flash`,
  `Pro`

## Data Sources

- Codex:
  - `codexUsage.source = auto` -> command first, then session log fallback
  - `command` -> command only
  - `sessionLog` -> newest `*.jsonl` in `codexUsage.sessionsRoot`
- Claude:
  - OAuth usage API from local credentials (`~/.claude/.credentials.json`)
  - fallback to optional command
  - fallback to local session rate-limit files (H/W only)
- Copilot:
  - GitHub auth session + Copilot API (`/copilot_internal/user`)
  - fallback to optional command
- Gemini:
  - OAuth credentials from `~/.gemini/oauth_creds.json`
  - refresh token flow (`oauth2.googleapis.com/token`)
  - Code Assist quota APIs:
    - `v1internal:loadCodeAssist`
    - `v1internal:retrieveUserQuota`

## Copilot Auth Flow

- On refresh, the extension first checks GitHub auth session silently.
- If no session exists, it requests GitHub sign-in once per VS Code session.
- After the first prompt attempt, periodic auto-refresh does not repeatedly pop
  up login UI.
- Required GitHub scopes are `read:user` and `user:email`.
- If login is cancelled or unavailable, Copilot shows unavailable and can still
  fall back to `copilotUsage.command`.

## UI Behavior

- Status bar text is always shown in English.
- Sidebar panel language is configurable via `aiUsage.language`.
- First install language behavior:
  - follows VS Code UI language
  - unsupported locale -> English
- Provider visibility toggles update display immediately without forcing a full
  refresh.
- If a `geminiUsage.*` setting write is rejected by VS Code, Gemini toggles are
  still applied from extension fallback state (`globalState`) for immediate
  statusbar consistency.
- Panel keeps previous usage values until new data arrives (no "loading" reset
  flicker).
- Auto refresh is fixed to every 60 seconds and always enabled (not configurable
  in panel/settings).

## Commands

- `Codex Usage: Refresh`
- `Codex Usage: Refresh Gemini`
- `Codex Usage: Open Output`

## Settings

- `aiUsage.language` (sidebar language only)
- `codexUsage.enabled`
- `claudeUsage.enabled`
- `copilotUsage.enabled`
- `geminiUsage.enabled`
- `geminiUsage.showFlashLite`
- `geminiUsage.showFlash`
- `geminiUsage.showPro`
- `codexUsage.source` (`auto` | `command` | `sessionLog`)
- `codexUsage.command`
- `codexUsage.commandTimeoutMs`
- `codexUsage.sessionsRoot`
- `claudeUsage.sessionsRoot`
- `claudeUsage.command`
- `claudeUsage.commandTimeoutMs`
- `copilotUsage.command`
- `copilotUsage.commandTimeoutMs`

## Local Development

$11. Open this folder in VS Code.
$11. Press `F5` to run Extension Development Host.
$11. Run `Codex Usage: Refresh` from Command Palette.

## Package

```bash
npx @vscode/vsce package
```text

## Version and Release Management

- Current local release target: `0.0.36`
- Publisher for local-managed installs: `local`
- View title includes version on the same line: `AI Usage: Settings v<version>`.
- Versioning policy: every code/document behavior change increments patch
  version by `+0.0.1` (example: `0.0.9` -> `0.0.10`).
- Documentation policy: every version bump must update change documents in the
  same commit/release (`CHANGELOG.md` required, plus `README.md`/`CAUTIONS.md`
  when release/process guidance changed).
- Localization policy: every new/changed user-facing text must be added for all
  supported languages in `I18N` (no English-only hardcoded UI text).
- Recurrence-prevention notes are tracked in `CAUTIONS.md`.

### Local Release Checklist

$11. Update `package.json` `version`.
$11. Keep `package.json` `publisher` as `local`.
$11. Build VSIX:

   ```bash
   npx @vscode/vsce package
   ```text

$11. Install/update in VS Code:

   ```bash
   code --install-extension .\\codex-usage-statusbar-<version>.vsix --force
   ```text

$11. Verify:

   ```bash
   code --list-extensions --show-versions | rg codex-usage-statusbar
   ```text

   - Expected managed entry: `local.codex-usage-statusbar@<version>`

$11. Append detailed release notes to `CHANGELOG.md` for that version.
$11. If release/process guidance changed, update `README.md` and `CAUTIONS.md`
   together in the same version.

### Duplicate Install Note

- If both `local.codex-usage-statusbar` and another publisher entry are
  installed, keep `local` and remove the other one.
- If old local folders remain under `.vscode/extensions`, remove outdated
  version folders and keep only the latest
  `local.codex-usage-statusbar-<version>`.
