# Changelog

All notable changes to `codex-usage-statusbar` are documented in this file.

## Unreleased

### Documented - Unreleased

- Clarified release-document policy:
  - every version bump must include change notes in `CHANGELOG.md`
  - when release/process guidance changes, update `README.md` and `CAUTIONS.md`
    in the same version

### Fixed - Unreleased

- Resolved Gemini model-toggle state mismatch where panel fallback save
  succeeded but statusbar still rendered all models.
- Updated Gemini toggle resolution order in `getConfig()` path:
$11. explicit VS Code setting value (`workspaceFolder/workspace/global`)
$11. fallback value from extension `globalState` (`fallback.geminiUsage.*`)
$11. default/config fallback
- Result: when `geminiUsage.*` write is rejected by VS Code, checkbox changes
  still apply to Gemini statusbar model filtering immediately.

## 0.0.36 - 2026-03-03

### Changed - 0.0.36 - 2026-03-03

- Bumped extension version to `0.0.36`.
- Updated view title version to `Settings v0.0.36`.
- Updated README local release target version to `0.0.36`.

### Packaging - 0.0.36 - 2026-03-03

- Repackaged VSIX for `0.0.36` and reinstalled with force update.
- Organized all local VSIX files into a dedicated `vsix/` folder.

## 0.0.35 - 2026-03-03

### Added - 0.0.35 - 2026-03-03

- Added recurrence-prevention operations document:
  - `CAUTIONS.md`

### Documented - 0.0.35 - 2026-03-03

- Consolidated recent incident history and prevention rules:
  - Gemini OAuth `invalid_client` root cause and prevention
  - panel setting update rejection (`not a registered configuration`) and
    fallback strategy
  - mandatory diagnostic logging checkpoints
  - pre-release checklist and debugging priority order

### Changed - 0.0.35 - 2026-03-03

- README release management section now references `CAUTIONS.md` as mandatory
  operational guidance.

## 0.0.34 - 2026-03-03

### Fixed - 0.0.34 - 2026-03-03

- Resolved Gemini model-toggle apply failure when VS Code rejects
  `geminiUsage.*` writes as unregistered settings in user config.
- Added fallback persistence for Gemini toggles in extension `globalState`:
  - `geminiUsage.enabled`
  - `geminiUsage.showPro`
  - `geminiUsage.showFlash`
  - `geminiUsage.showFlashLite`
- Gemini statusbar rebuild now runs for `geminiUsage.enabled` changes as well
  (same immediate cache path).

### Added - 0.0.34 - 2026-03-03

- Fallback diagnostics in Output channel:
  - `[panel] update fallback saved key=...`

## 0.0.33 - 2026-03-03

### Fixed - 0.0.33 - 2026-03-03

- Panel Gemini model toggles (`Pro/Flash/Flash Lite`) now force reliable
  statusbar cache rebuild when changed.
- Added stronger post-update rebuild sequence for Gemini toggle updates
  (immediate + short delayed passes).

### Added - 0.0.33 - 2026-03-03

- Detailed panel/config diagnostics in Output channel (`AI Usage`) for Gemini
  toggle troubleshooting:
  - panel message receipt
  - update request key/value
  - before/after Gemini toggle state snapshot
  - explicit cache rebuild command invocation logs
  - config-change snapshot logs

## 0.0.32 - 2026-03-03

### Fixed - 0.0.32 - 2026-03-03

- Resolved Gemini refresh failures caused by outdated default OAuth client id.
  - default `client_id` changed to current Gemini CLI client id.
- Gemini refresh now tries multiple `(client_id, client_secret)` pairs instead
  of a single fixed id with secret rotation only.
  - credentials file pair (if present)
  - discovered pair from installed `@google/gemini-cli-core`
    (`dist/src/code_assist/oauth2.js`)
  - current default pair
  - legacy compatibility pairs
- Persist refreshed token with the successful `client_id/client_secret` pair to
  reduce repeated failures on next refresh.

### Added - 0.0.32 - 2026-03-03

- Detailed Gemini refresh diagnostics in Output channel:
  - discovered oauth source path
  - candidate list (masked client-id tail)
  - per-candidate refresh failure reason
  - explicit exhausted-candidates log

### Result - 0.0.32 - 2026-03-03

- Environments showing:
  - `Gemini OAuth token refresh failed after auth error` now recover if any
    valid installed Gemini CLI OAuth client pair is available locally.

## 0.0.31 - 2026-03-03

### Fixed - 0.0.31 - 2026-03-03

- Resolved Gemini token-refresh `invalid_client` failures caused by mismatched
  OAuth client secret.
- Updated default Gemini OAuth client secret to match current Gemini CLI
  implementation.
- Added Gemini refresh fallback across multiple client-secret candidates:
  - credential file secret (if present)
  - current Gemini CLI secret
  - legacy secret

### Result - 0.0.31 - 2026-03-03

- Gemini refresh now succeeds on environments where previous builds failed with:
  - `Gemini OAuth token refresh failed after auth error`

## 0.0.30 - 2026-03-03

### Fixed - 0.0.30 - 2026-03-03

- Resolved Gemini false-unavailable case where refresh was forced too early and
  failure immediately surfaced as:
  - `Gemini OAuth token refresh failed`
- Gemini auth flow now prefers existing access token first and refreshes only
  when needed:
$11. parse/normalize `expiry_date` robustly (supports seconds/ms)
$11. if expiry appears near, attempt proactive refresh but do not fail hard on
     proactive refresh failure
$11. call Gemini APIs with current token
$11. on actual 401/403 auth failure, refresh token and retry once

### Added - 0.0.30 - 2026-03-03

- Additional Gemini auth diagnostics in Output channel:
  - expiry normalization result and expired state
  - proactive refresh success/failure branch
  - auth-failure-triggered refresh branch and retry status

## 0.0.29 - 2026-03-03

### Fixed - 0.0.29 - 2026-03-03

- Improved Gemini model-toggle propagation reliability:
  - when panel toggles (`geminiUsage.showPro/showFlash/showFlashLite`) change,
    Gemini status bar cache rebuild now runs twice (immediate + short delayed
    pass) to avoid timing races with configuration propagation.
- Added explicit configuration-change handling marker for Gemini toggles.

### Added - 0.0.29 - 2026-03-03

- Detailed Gemini cache-apply logs in Output channel (`AI Usage`) to diagnose
  toggle-sync issues:
  - current enabled/toggle state snapshot
  - hidden/provider-disabled branch
  - final statusbar text after cache rebuild
  - missing-cache branch

## 0.0.28 - 2026-03-02

### Fixed - 0.0.28 - 2026-03-02

- Gemini model visibility toggles (`Pro/Flash/Flash Lite`) now trigger immediate
  statusbar rebuild from cached Gemini result.
- Added explicit cache-only Gemini refresh command path used by panel toggle
  updates to avoid stale status text.

### Changed - 0.0.28 - 2026-03-02

- Provider color alignment updated:
  - Gemini provider dot in panel is now yellow to match Gemini statusbar item
    color theme.
- Gemini grouped status text keeps model separation but removes per-model color
  markers:
  - format: `P:<left%> <time> | F:<left%> <time> | FL:<left%> <time>`
- Panel compactness improved:
  - reduced vertical paddings/margins for body sections, checkbox items, and
    rows.
- Gemini model toggle section order kept as:
  - `Pro` -> `Flash` -> `Flash Lite`

## 0.0.27 - 2026-03-02

### Changed - 0.0.27 - 2026-03-02

- Gemini display order unified to:
  - `Pro` -> `Flash` -> `Flash Lite`
  - applied to grouped status summary and panel controls
- Gemini status bar summary readability improved with explicit model separators
  and labels:
  - format: `<marker><shortLabel>:<left%> <time> | ...`
  - example: `🟣P:98% 23h 10m | 🔵F:90% 18h 2m | 🟢FL:97% 18h 2m`
- Gemini panel rows now show the same model markers as status bar:
  - `🟣 Pro`, `🔵 Flash`, `🟢 Flash Lite`
- Gemini model-toggle changes in panel now force immediate statusbar text
  refresh from cached Gemini result.

## 0.0.26 - 2026-03-02

### Added - 0.0.26 - 2026-03-02

- New `Gemini` provider in status bar and panel.
- Gemini refresh command:
  - `codexUsage.refreshGemini`
- Gemini settings:
  - `geminiUsage.enabled`
  - `geminiUsage.showFlashLite`
  - `geminiUsage.showFlash`
  - `geminiUsage.showPro`

### Changed - 0.0.26 - 2026-03-02

- Full refresh now includes 4 providers in parallel:
  - `Codex`, `Claude`, `Copilot`, `Gemini`
- Provider-specific refresh lock/state handling now includes `gemini`.
- Panel visibility list now includes `Gemini`.
- Panel usage cards now include `Gemini` card with per-group bars.
- Status bar text rebuild now supports Gemini grouped model summary.

### Gemini Data Source - 0.0.26 - 2026-03-02

- Implemented Gemini quota fetch based on OAuth + Code Assist APIs:
$11. load creds from `~/.gemini/oauth_creds.json`
$11. refresh token via `oauth2.googleapis.com/token` when expired
$11. fetch project id via
     `cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`
$11. fetch quota buckets via
     `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`
- API key mode (`GEMINI_API_KEY` / `GOOGLE_API_KEY`) is detected and marked as
  quota-unavailable mode.

### Gemini Grouping - 0.0.26 - 2026-03-02

- Buckets are grouped into three statusbar model groups:
  - `Flash Lite`
  - `Flash`
  - `Pro`
- For each group, if multiple backing model buckets exist, the group shows the
  lower remaining percentage (conservative summary).
- Panel provides per-group toggle checkboxes to control which of the 3 groups
  appear in Gemini status bar text.

## 0.0.25 - 2026-03-02

### Fixed - 0.0.25 - 2026-03-02

- Provider cards (notably Claude) could be missing entirely on initial panel
  load before first result payload arrived.

### Changed - 0.0.25 - 2026-03-02

- Provider cards are now always rendered when provider is enabled.
- While provider result is not ready yet, card shows localized loading text
  instead of disappearing.

## 0.0.24 - 2026-03-02

### Changed - 0.0.24 - 2026-03-02

- Panel refresh control layout adjusted:
  - provider refresh buttons moved into each provider card header (next to
    provider title)
  - full refresh button moved back to the bottom of panel

## 0.0.23 - 2026-03-02

### Changed - 0.0.23 - 2026-03-02

- Panel refresh-button UX polish during full refresh:
  - provider-specific refresh buttons are now disabled while full refresh is
    running.
- View title version updated to:
  - `Settings v0.0.23`

## 0.0.22 - 2026-03-02

### Added - 0.0.22 - 2026-03-02

- Per-provider refresh controls:
  - panel buttons for `Codex`, `Claude`, `Copilot`
  - status bar click refreshes only the clicked provider
- Full refresh orchestration now calls per-provider refresh tasks concurrently.

### Changed - 0.0.22 - 2026-03-02

- Fast-first UI updates:
  - each provider updates status bar/panel immediately when its own fetch
    finishes (no wait-for-all barrier).
- Refresh lock behavior:
  - while full refresh is in progress, new panel/statusbar refresh requests are
    ignored.
  - per-provider duplicate refresh requests are ignored while that provider is
    already in progress.

## 0.0.21 - 2026-03-02

### Changed - 0.0.21 - 2026-03-02

- Updated view title version suffix to match package version:
  - `Settings v0.0.21`

## 0.0.20 - 2026-03-02

### Added - 0.0.20 - 2026-03-02

- Provider retry policy (up to 3 attempts):
  - Claude OAuth usage fetch
  - Copilot GitHub usage fetch

### Changed - 0.0.20 - 2026-03-02

- Refresh re-entry policy:
  - While a refresh cycle is in progress, incoming refresh triggers from
    panel/status bar are ignored.
- Claude OAuth timeout increased to reduce false timeout failures:
  - `8s` -> `12s`
- Refresh button label icon cleanup:
  - Removed text arrow prefix from localized `refreshNow` labels.
  - Keeps only aligned CSS spinner during loading state.

## 0.0.19 - 2026-03-02

### Added - 0.0.19 - 2026-03-02

- Detailed refresh-cycle logging in Output channel:
  - refresh start/end with cycle id and total duration
  - provider-level start/ok/fail/throw logs
  - provider-level duration and source label on success
  - disabled-provider skip logs

### Changed - 0.0.19 - 2026-03-02

- Replaced refresh-button glyph spinner with CSS ring spinner for better visual
  alignment.
- Refresh button now uses stable inline layout while refreshing.

## 0.0.18 - 2026-03-02

### Fixed - 0.0.18 - 2026-03-02

- Claude value could oscillate between real H/W limits and assumed full when
  OAuth intermittently timed out or returned HTTP 500.

### Changed - 0.0.18 - 2026-03-02

- Added transient-error cache fallback for Claude:
  - If OAuth fails with timeout/500/network and a previous successful Claude
    rate-limit snapshot exists, use cached snapshot instead of assumed full.
- Added panel refresh UX improvements:
  - Refresh button disables while refresh is in progress.
  - Button label switches to localized `refreshing` text.
  - Spinner animation shown during refresh.

## 0.0.17 - 2026-03-02

### Changed - 0.0.17 - 2026-03-02

- Claude no-data handling is now separated from hard failure cases.

### Behavior - 0.0.17 - 2026-03-02

- Hard failure (e.g. missing install/auth environment): keeps `Unavailable`.
- Soft no-data (e.g. session/rate-limit data not materialized yet): assumes
  `Full (100%)`.
- Removed token I/O shorthand fallback path for Claude; focus is H/W quota
  display.

### Notes - 0.0.17 - 2026-03-02

- Weekly (`7d`) data is usually available via OAuth when auth is valid, but it
  can be missing in transient/no-data responses; this is now treated as assumed
  full rather than unavailable.

## 0.0.16 - 2026-03-02

### Fixed - 0.0.16 - 2026-03-02

- Claude status could show token-style fallback text like `I1 O296` when
  OAuth/rate-limit fetch failed.

### Changed - 0.0.16 - 2026-03-02

- Removed Claude token-count fallback display from local session path.
- Claude now prefers:
$11. OAuth rate limits
$11. optional command
$11. local session rate limits (searches recent session files)
- If no rate-limit data is found, Claude shows unavailable instead of token I/O
  shorthand.

## 0.0.15 - 2026-03-02

### Changed - 0.0.15 - 2026-03-02

- Moved version display to the view title line by updating view name:
  - `Settings` -> `Settings v0.0.15`
- Removed separate in-panel version line to avoid duplicate/second-line version
  display.

### Result - 0.0.15 - 2026-03-02

- Title now appears as one line in VS Code:
  - `AI Usage: Settings v0.0.15`

## 0.0.14 - 2026-03-02

### Changed - 0.0.14 - 2026-03-02

- Renamed VS Code Output channel from `Codex Usage` to `AI Usage`.

### Why - 0.0.14 - 2026-03-02

- Aligns Output channel label with extension display name and user expectation.

## 0.0.13 - 2026-03-02

### Fixed - 0.0.13 - 2026-03-02

- Copilot could show `Unavailable` immediately after extension update/restart
  even though manual refresh succeeded.

### Changed - 0.0.13 - 2026-03-02

- Added one-time startup retry for Copilot fetch when initial result indicates
  likely transient startup/auth readiness issue.
- Retry is delayed briefly (`3500ms`) and runs only once per extension
  activation.

### Why - 0.0.13 - 2026-03-02

- VS Code/GitHub auth session readiness can lag right after extension reload,
  causing first Copilot check to fail transiently.

## 0.0.12 - 2026-03-02

### Changed - 0.0.12 - 2026-03-02

- Removed redundant activation event from manifest:
  - deleted `onCommand:codexUsage.refresh` in `activationEvents`
- Kept startup activation via `onStartupFinished`.

### Why - 0.0.12 - 2026-03-02

- VS Code auto-generates command activation from `contributes.commands`, so
  explicit `onCommand` entry was unnecessary and produced editor warning.

### Technical details - 0.0.12 - 2026-03-02

- No runtime behavior change in refresh command execution.
- Command contribution remains unchanged: `codexUsage.refresh`.

## 0.0.11 - 2026-03-02

### Changed - 0.0.11 - 2026-03-02

- Sidebar fixed auto-refresh note is now localized by selected panel language.
- Removed remaining hardcoded English text for that note.

### Added - 0.0.11 - 2026-03-02

- `autoRefreshFixedNote` i18n key for all supported languages:
  - `ko`, `en`, `ja`, `zh-cn`, `zh-tw`, `fr`, `de`, `es`, `pt`, `ru`, `it`,
    `tr`, `pl`, `nl`, `vi`, `id`

### Documentation - 0.0.11 - 2026-03-02

- Added explicit localization guardrail:
  - Any new/changed user-facing text must be provided for all supported
    languages in `I18N`.
- Updated command list to match actual manifest (auto-refresh toggle command
  removed).

## 0.0.10 - 2026-03-02

### Changed - 0.0.10 - 2026-03-02

- Auto refresh behavior is now fixed and non-configurable:
  - Always enabled
  - Runs every 60 seconds
- Removed auto-refresh controls from sidebar panel UI.
- Added panel note text: `Auto refresh runs every 60 seconds.`

### Removed - 0.0.10 - 2026-03-02

- Command palette action: `Codex Usage: Toggle Auto Refresh`
- Settings keys:
  - `codexUsage.enableAutoRefresh`
  - `codexUsage.refreshIntervalSeconds`

### Why - 0.0.10 - 2026-03-02

- Prevents accidental disablement or interval drift and keeps refresh cadence
  predictable for all users.

### Technical details - 0.0.10 - 2026-03-02

- Added internal constant: `AUTO_REFRESH_INTERVAL_MS = 60000`.
- Timer start logic now always schedules fixed-interval refresh.
- Manifest cleaned so removed command/settings are not exposed in VS Code UI.

## 0.0.9 - 2026-03-02

### Added - 0.0.9 - 2026-03-02

- Status bar weekly safety signal for dual-window providers (Codex/Claude).

### Changed - 0.0.9 - 2026-03-02

- When 5-hour (`H`) still has remaining quota but weekly (`W`) left is below
  `5%`, status bar now shows weekly info together with hourly info.
- New compact format in that case:
  - `H<left%> <time> W<left%> <time>`
  - Example: `H62% 4h 10m W3% 2d 5h`

### Why - 0.0.9 - 2026-03-02

- Prevents false confidence from seeing only `H` remaining while weekly quota is
  near depletion and can end runs unexpectedly.

### Technical details - 0.0.9 - 2026-03-02

- Added threshold constant: `WEEKLY_LOW_PERCENT_THRESHOLD = 5`.
- Applied in shared rate-limit summary function so behavior is consistent for
  Codex and Claude summaries.

## 0.0.8 - 2026-03-02

### Changed - 0.0.8 - 2026-03-02

- Normalized unknown/empty quota display across status bar, sidebar cards, and
  tooltip table.
- Replaced ambiguous `?` values with explicit values:
  - Percent unknown/uninitialized -> `Full`
  - Reset/remaining time unknown/uninitialized -> `-`
- Applied the same display rule to all providers (Codex/Claude/Copilot) via
  shared formatting functions.

### Technical details - 0.0.8 - 2026-03-02

- Updated rate-limit summary generation to return `HFull -`/`WFull -` when usage
  data exists but utilization/reset time is not yet materialized.
- Updated monthly quota summary formatting for Copilot from `M?% ?` style to
  `MFull -`.
- Updated raw detail strings (`H left ...`, `W left ...`) to avoid `?` and use
  `Full`/`-`.
- Updated sidebar webview rendering so card rows also use `Full` and `-`
  consistently.

### Verification - 0.0.8 - 2026-03-02

- Syntax check passed: `node --check extension.js`
- Packaged VSIX and installed with force update.
- Installed version confirmed: `local.codex-usage-statusbar@0.0.8`

## 0.0.7 - 2026-03-02

### Added - 0.0.7 - 2026-03-02

- Sidebar panel version label (`v<version>`) at top-right for quick runtime
  verification.

### Changed - 0.0.7 - 2026-03-02

- Copilot authentication flow:
  - First tries silent GitHub session lookup.
  - If no session exists, prompts sign-in once per VS Code session using
    `createIfNone: true`.
  - Prevents repeated login popups during auto-refresh loops.
- Updated GitHub auth scope request to `read:user` + `user:email`.
- Improved no-session guidance text to `Accounts -> GitHub`.

### Packaging/installation - 0.0.7 - 2026-03-02

- Standardized local-managed install target to `publisher: local`.
- Removed duplicate non-local install to prevent extension duplication issues.

## 0.0.6 - 2026-03-02

### Baseline - 0.0.6 - 2026-03-02

- Multi-provider status bar extension baseline in current project branch.
- Sidebar settings panel and per-provider usage display available.

### Notes - 0.0.6 - 2026-03-02

- This version existed before the 0.0.7 authentication and panel-version
  enhancements.
