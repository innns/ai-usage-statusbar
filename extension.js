const vscode = require('vscode');
const { exec } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX_ICON = '$(pulse)';
const CLAUDE_ICON = '$(sparkle)';
const COPILOT_ICON = '$(github)';
const GEMINI_ICON = '$(hubot)';
const STATUS_BAR_LANGUAGE = 'en';
const WEEKLY_LOW_PERCENT_THRESHOLD = 5;
const AUTO_REFRESH_INTERVAL_MS = 60 * 1000;
const COPILOT_STARTUP_RETRY_DELAY_MS = 3500;
const PROVIDER_MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1200;
const CLAUDE_OAUTH_TIMEOUT_MS = 12000;
const CLAUDE_SESSION_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
const CLAUDE_PLAN_TOKEN_LIMITS = { pro: 44000, max_5: 88000, max5: 88000, max_20: 220000, max20: 220000, team: 44000 };
const GEMINI_TIMEOUT_MS = 12000;
const GEMINI_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GEMINI_CODE_ASSIST_ENDPOINT = '/v1internal:loadCodeAssist';
const GEMINI_QUOTA_ENDPOINT = '/v1internal:retrieveUserQuota';
const GEMINI_CLIENT_ID = process.env.GEMINI_CLIENT_ID || '';
const GEMINI_LEGACY_CLIENT_ID = process.env.GEMINI_LEGACY_CLIENT_ID || '';
const GEMINI_CLIENT_SECRET = process.env.GEMINI_CLIENT_SECRET || '';
const GEMINI_LEGACY_CLIENT_SECRET = process.env.GEMINI_LEGACY_CLIENT_SECRET || '';
const SUPPORTED_LANGUAGES = new Set([
  'ko', 'en', 'ja', 'zh-cn', 'zh-tw', 'fr', 'de', 'es', 'pt', 'ru', 'it', 'tr', 'pl', 'nl', 'vi', 'id',
]);
let copilotAuthPromptAttempted = false;
let lastClaudeRateLimitResult = null;
let lastClaudeOauth429At = 0;
let lastClaudeOauth429RetryAfterMs = 5 * 60 * 1000; // starts at 5 min, exponential backoff
let lastClaudeOauthSuccessAt = 0; // timestamp of last successful API call
const CLAUDE_OAUTH_MIN_INTERVAL_MS = 5 * 60 * 1000; // call API at most once per 5 minutes
let extensionState = null;

function activate(context) {
  extensionState = context.globalState;
  const output = vscode.window.createOutputChannel('AI Usage');
  const codexItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const claudeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  const copilotItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  const geminiItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
  codexItem.color = '#4fc1ff';
  claudeItem.color = '#f48771';
  copilotItem.color = '#4ec9b0';
  geminiItem.color = '#d7ba7d';

  let timer = null;
  let panel = null;
  let lastResults = { codex: null, claude: null, copilot: null, gemini: null };
  let copilotStartupRetryScheduled = false;
  let allRefreshInFlight = null;
  const providerRefreshInFlight = { codex: null, claude: null, copilot: null, gemini: null };
  const refreshState = { all: false, providers: { codex: false, claude: false, copilot: false, gemini: false } };
  let refreshSequence = 0;
  void ensureInitialLanguageSetting();

  codexItem.command = 'codexUsage.refreshCodex';
  claudeItem.command = 'codexUsage.refreshClaude';
  copilotItem.command = 'codexUsage.refreshCopilot';
  geminiItem.command = 'codexUsage.refreshGemini';
  // 초기 로딩: 아이콘 + 스피너 (이후 새로고침 시에는 이전 데이터를 유지)
  codexItem.text = `${CODEX_ICON} $(sync~spin)`;
  claudeItem.text = `${CLAUDE_ICON} $(sync~spin)`;
  copilotItem.text = `${COPILOT_ICON} $(sync~spin)`;
  geminiItem.text = `${GEMINI_ICON} $(sync~spin)`;
  const cfg0 = getConfig();
  if (cfg0.codexEnabled) codexItem.show();
  if (cfg0.claudeEnabled) claudeItem.show();
  if (cfg0.copilotEnabled) copilotItem.show();
  if (cfg0.geminiEnabled) geminiItem.show();

  const emitRefreshState = () => {
    panel?.postRefreshState({
      all: refreshState.all,
      providers: { ...refreshState.providers },
    });
  };

  const refreshGeminiStatusFromCache = () => {
    const cfg = getConfig();
    output.appendLine(
      `[gemini:cache] apply enabled=${cfg.geminiEnabled} show={pro:${cfg.geminiShowPro},flash:${cfg.geminiShowFlash},flashLite:${cfg.geminiShowFlashLite}}`
    );
    if (!cfg.geminiEnabled) {
      geminiItem.hide();
      panel?.postResults(lastResults);
      output.appendLine('[gemini:cache] hidden (provider disabled)');
      return;
    }
    if (lastResults.gemini) {
      const text = `${GEMINI_ICON} ${lastResults.gemini.ok ? buildStatusBarTextEn(lastResults.gemini) : '-'}`;
      geminiItem.text = text;
      geminiItem.tooltip = buildProviderTooltip('Gemini', GEMINI_ICON, lastResults.gemini);
      output.appendLine(`[gemini:cache] text => ${text}`);
    } else {
      output.appendLine('[gemini:cache] no cached result yet');
    }
    geminiItem.show();
    panel?.postResults(lastResults);
  };

  const applyProviderResult = (provider, result) => {
    if (provider === 'codex') {
      if (result) {
        if (!result.ok) output.appendLine(`[error:codex] ${result.error}`);
        codexItem.text = `${CODEX_ICON} ${result.ok ? buildStatusBarTextEn(result) : '-'}`;
        codexItem.tooltip = buildProviderTooltip('Codex', CODEX_ICON, result);
        codexItem.show();
      } else {
        codexItem.hide();
      }
      lastResults.codex = result;
    } else if (provider === 'claude') {
      if (result) {
        if (!result.ok) output.appendLine(`[error:claude] ${result.error}`);
        claudeItem.text = `${CLAUDE_ICON} ${result.ok ? buildStatusBarTextEn(result) : '-'}`;
        claudeItem.tooltip = buildProviderTooltip('Claude', CLAUDE_ICON, result);
        claudeItem.show();
      } else {
        claudeItem.hide();
      }
      lastResults.claude = result;
    } else if (provider === 'copilot') {
      if (result) {
        if (!result.ok) output.appendLine(`[error:copilot] ${result.error}`);
        copilotItem.text = `${COPILOT_ICON} ${result.ok ? buildStatusBarTextEn(result) : '-'}`;
        copilotItem.tooltip = buildProviderTooltip('Copilot', COPILOT_ICON, result);
        copilotItem.show();
      } else {
        copilotItem.hide();
      }
      lastResults.copilot = result;
    } else if (provider === 'gemini') {
      if (result) {
        if (!result.ok) output.appendLine(`[error:gemini] ${result.error}`);
        geminiItem.text = `${GEMINI_ICON} ${result.ok ? buildStatusBarTextEn(result) : '-'}`;
        geminiItem.tooltip = buildProviderTooltip('Gemini', GEMINI_ICON, result);
        geminiItem.show();
      } else {
        geminiItem.hide();
      }
      lastResults.gemini = result;
    }
    panel?.postResults(lastResults);
  };

  const runProviderRefresh = async (provider, options = {}) => {
    const { refreshId = ++refreshSequence, allowWhenAll = false } = options;
    if (allRefreshInFlight && !allowWhenAll) {
      output.appendLine(`[refresh] ignored: ${provider} requested while full refresh is running`);
      return null;
    }
    if (providerRefreshInFlight[provider]) {
      output.appendLine(`[refresh] ignored: ${provider} already in progress`);
      return null;
    }

    const cfg = getConfig();
    const enabled = provider === 'codex'
      ? cfg.codexEnabled
      : provider === 'claude'
        ? cfg.claudeEnabled
        : provider === 'copilot'
          ? cfg.copilotEnabled
          : cfg.geminiEnabled;
    if (!enabled) {
      output.appendLine(`[refresh:${refreshId}] ${provider} skipped (disabled)`);
      applyProviderResult(provider, null);
      return null;
    }

    refreshState.providers[provider] = true;
    emitRefreshState();

    const task = (async () => {
      const t0 = Date.now();
      output.appendLine(`[refresh:${refreshId}] ${provider} fetch start`);
      let result;
      try {
        if (provider === 'codex') result = await fetchUsage(output);
        else if (provider === 'claude') result = await fetchClaudeUsage(output);
        else if (provider === 'copilot') result = await fetchCopilotUsage(output);
        else result = await fetchGeminiUsage(output);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      const ms = Date.now() - t0;
      if (!result) {
        output.appendLine(`[refresh:${refreshId}] ${provider} fetch empty (${ms}ms)`);
      } else if (result.ok) {
        output.appendLine(`[refresh:${refreshId}] ${provider} ok (${ms}ms)${result.sourceLabel ? ` [${result.sourceLabel}]` : ''}`);
      } else {
        output.appendLine(`[refresh:${refreshId}] ${provider} fail (${ms}ms): ${result.error}`);
      }

      applyProviderResult(provider, result || null);

      if (
        provider === 'copilot' &&
        !copilotStartupRetryScheduled &&
        shouldRetryCopilotOnStartup(result)
      ) {
        copilotStartupRetryScheduled = true;
        output.appendLine('[info:copilot] scheduling one startup retry');
        setTimeout(() => {
          void runProviderRefresh('copilot');
        }, COPILOT_STARTUP_RETRY_DELAY_MS);
      }

      return result || null;
    })()
      .finally(() => {
        providerRefreshInFlight[provider] = null;
        refreshState.providers[provider] = false;
        emitRefreshState();
      });

    providerRefreshInFlight[provider] = task;
    return task;
  };

  const refreshAll = async () => {
    if (allRefreshInFlight) {
      output.appendLine('[refresh] ignored: already in progress');
      return null;
    }

    allRefreshInFlight = (async () => {
      const refreshId = ++refreshSequence;
      const startedAt = Date.now();
      refreshState.all = true;
      emitRefreshState();
      output.appendLine(`[refresh:${refreshId}] start`);

      await Promise.all([
        runProviderRefresh('codex', { refreshId, allowWhenAll: true }),
        runProviderRefresh('claude', { refreshId, allowWhenAll: true }),
        runProviderRefresh('copilot', { refreshId, allowWhenAll: true }),
        runProviderRefresh('gemini', { refreshId, allowWhenAll: true }),
      ]);

      output.appendLine(`[refresh:${refreshId}] done (${Date.now() - startedAt}ms)`);
      return lastResults;
    })().finally(() => {
      allRefreshInFlight = null;
      refreshState.all = false;
      emitRefreshState();
    });

    return allRefreshInFlight;
  };

  const startTimer = () => {
    stopTimer();
    timer = setInterval(() => {
      void refreshAll();
    }, AUTO_REFRESH_INTERVAL_MS);
  };

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const onConfigChanged = vscode.workspace.onDidChangeConfiguration((e) => {
    // 언어 변경 시 새로고침 없이 툴팁 + 상태바 텍스트 즉시 재빌드
    if (e.affectsConfiguration('aiUsage.language')) {
      if (lastResults.codex) {
        codexItem.tooltip = buildProviderTooltip('Codex', CODEX_ICON, lastResults.codex);
        codexItem.text = `${CODEX_ICON} ${lastResults.codex.ok ? buildStatusBarTextEn(lastResults.codex) : '-'}`;
      }
      if (lastResults.claude) {
        claudeItem.tooltip = buildProviderTooltip('Claude', CLAUDE_ICON, lastResults.claude);
        claudeItem.text = `${CLAUDE_ICON} ${lastResults.claude.ok ? buildStatusBarTextEn(lastResults.claude) : '-'}`;
      }
      if (lastResults.copilot) {
        copilotItem.tooltip = buildProviderTooltip('Copilot', COPILOT_ICON, lastResults.copilot);
        copilotItem.text = `${COPILOT_ICON} ${lastResults.copilot.ok ? buildStatusBarTextEn(lastResults.copilot) : '-'}`;
      }
      if (lastResults.gemini) {
        geminiItem.tooltip = buildProviderTooltip('Gemini', GEMINI_ICON, lastResults.gemini);
        geminiItem.text = `${GEMINI_ICON} ${lastResults.gemini.ok ? buildStatusBarTextEn(lastResults.gemini) : '-'}`;
      }
      return;
    }

    // 표시 항목 토글은 재조회 없이 즉시 표시 상태만 변경
    const geminiToggleChanged = (
      e.affectsConfiguration('geminiUsage.enabled') ||
      e.affectsConfiguration('geminiUsage.showFlashLite') ||
      e.affectsConfiguration('geminiUsage.showFlash') ||
      e.affectsConfiguration('geminiUsage.showPro')
    );
    if (
      e.affectsConfiguration('codexUsage.enabled') ||
      e.affectsConfiguration('claudeUsage.enabled') ||
      e.affectsConfiguration('copilotUsage.enabled') ||
      geminiToggleChanged
    ) {
      if (geminiToggleChanged) {
        output.appendLine('[config] gemini toggle changed');
      }
      const cfg = getConfig();
      if (geminiToggleChanged) {
        output.appendLine(
          `[config] gemini show={pro:${cfg.geminiShowPro},flash:${cfg.geminiShowFlash},flashLite:${cfg.geminiShowFlashLite}}`
        );
      }
      if (cfg.codexEnabled) {
        if (lastResults.codex) {
          codexItem.text = `${CODEX_ICON} ${lastResults.codex.ok ? buildStatusBarTextEn(lastResults.codex) : '-'}`;
          codexItem.tooltip = buildProviderTooltip('Codex', CODEX_ICON, lastResults.codex);
        }
        codexItem.show();
      } else {
        codexItem.hide();
      }

      if (cfg.claudeEnabled) {
        if (lastResults.claude) {
          claudeItem.text = `${CLAUDE_ICON} ${lastResults.claude.ok ? buildStatusBarTextEn(lastResults.claude) : '-'}`;
          claudeItem.tooltip = buildProviderTooltip('Claude', CLAUDE_ICON, lastResults.claude);
        }
        claudeItem.show();
      } else {
        claudeItem.hide();
      }

      if (cfg.copilotEnabled) {
        if (lastResults.copilot) {
          copilotItem.text = `${COPILOT_ICON} ${lastResults.copilot.ok ? buildStatusBarTextEn(lastResults.copilot) : '-'}`;
          copilotItem.tooltip = buildProviderTooltip('Copilot', COPILOT_ICON, lastResults.copilot);
        }
        copilotItem.show();
      } else {
        copilotItem.hide();
      }

      if (cfg.geminiEnabled) {
        refreshGeminiStatusFromCache();
      } else {
        geminiItem.hide();
      }

      panel?.postResults(lastResults);
      emitRefreshState();
      return;
    }

    if (
      !e.affectsConfiguration('codexUsage') &&
      !e.affectsConfiguration('claudeUsage') &&
      !e.affectsConfiguration('copilotUsage') &&
      !e.affectsConfiguration('geminiUsage')
    ) {
      return;
    }

    startTimer();
    void refreshAll();
  });

  const refreshCmd = vscode.commands.registerCommand('codexUsage.refresh', async () => {
    await refreshAll();
  });
  const refreshCodexCmd = vscode.commands.registerCommand('codexUsage.refreshCodex', async () => {
    await runProviderRefresh('codex');
  });
  const refreshClaudeCmd = vscode.commands.registerCommand('codexUsage.refreshClaude', async () => {
    await runProviderRefresh('claude');
  });
  const refreshCopilotCmd = vscode.commands.registerCommand('codexUsage.refreshCopilot', async () => {
    await runProviderRefresh('copilot');
  });
  const refreshGeminiCmd = vscode.commands.registerCommand('codexUsage.refreshGemini', async () => {
    await runProviderRefresh('gemini');
  });
  const refreshGeminiFromCacheCmd = vscode.commands.registerCommand('codexUsage.refreshGeminiFromCache', async () => {
    const cfg = getConfig();
    output.appendLine(
      `[gemini:cache] command invoked show={pro:${cfg.geminiShowPro},flash:${cfg.geminiShowFlash},flashLite:${cfg.geminiShowFlashLite}}`
    );
    refreshGeminiStatusFromCache();
  });

  const openOutputCmd = vscode.commands.registerCommand('codexUsage.openOutput', () => {
    output.show(true);
  });

  panel = new SettingsPanelProvider(context, () => lastResults, output);

  context.subscriptions.push(
    codexItem,
    claudeItem,
    copilotItem,
    geminiItem,
    output,
    refreshCmd,
    refreshCodexCmd,
    refreshClaudeCmd,
    refreshCopilotCmd,
    refreshGeminiCmd,
    refreshGeminiFromCacheCmd,
    openOutputCmd,
    onConfigChanged,
    vscode.window.registerWebviewViewProvider(SettingsPanelProvider.viewType, panel)
  );

  startTimer();
  void refreshAll();
}

const I18N = {
  ko: {
    usage: '사용량', visibility: '표시 항목', autoRefresh: '자동 새로고침',
    interval: '주기 (초)', language: '언어', refreshNow: '지금 새로고침',
    unavailable: '사용 불가', loading: '불러오는 중…', noData: '데이터 없음',
    hourly: '5시간', weekly: '7일', monthly: '월간',
    left: '남음', resets: '리셋', unlimited: '무제한',
    clickToRefresh: '클릭하여 새로고침',
    group: '그룹', leftLabel: '잔여', resetLabel: '리셋', resetsIn: '리셋까지',
    autoRefreshOn: '자동 새로고침 켜짐', autoRefreshOff: '자동 새로고침 꺼짐',
    dUnit: '일', hUnit: '시간', mUnit: '분',
    noPercentData: '데이터 없음', unknown: '알 수 없음',
    refreshing: '새로고침 중...',
    autoRefreshFixedNote: '자동 새로고침은 60초마다 실행됩니다.',
  },
  en: {
    usage: 'Usage', visibility: 'Show Providers', autoRefresh: 'Auto Refresh',
    interval: 'Interval (sec)', language: 'Language', refreshNow: 'Refresh Now',
    unavailable: 'Unavailable', loading: 'Loading…', noData: 'No data',
    hourly: '5h', weekly: '7d', monthly: 'Monthly',
    left: 'left', resets: 'resets', unlimited: 'Unlimited',
    clickToRefresh: 'Click to refresh',
    group: 'Group', leftLabel: 'Left', resetLabel: 'Reset', resetsIn: 'Resets In',
    autoRefreshOn: 'Auto refresh: ON', autoRefreshOff: 'Auto refresh: OFF',
    dUnit: 'd', hUnit: 'h', mUnit: 'm',
    noPercentData: 'No data', unknown: 'Unknown',
    refreshing: 'Refreshing...',
    autoRefreshFixedNote: 'Auto refresh runs every 60 seconds.',
  },
  ja: {
    usage: '使用量', visibility: '表示設定', autoRefresh: '自動更新',
    interval: '間隔 (秒)', language: '言語', refreshNow: '今すぐ更新',
    unavailable: '利用不可', loading: '読み込み中…', noData: 'データなし',
    hourly: '5時間', weekly: '7日', monthly: '月間',
    left: '残り', resets: 'リセット', unlimited: '無制限',
    clickToRefresh: 'クリックして更新',
    group: 'グループ', leftLabel: '残り', resetLabel: 'リセット', resetsIn: 'リセットまで',
    autoRefreshOn: '自動更新: オン', autoRefreshOff: '自動更新: オフ',
    dUnit: '日', hUnit: '時間', mUnit: '分',
    noPercentData: 'データなし', unknown: '不明',
    refreshing: '更新中...',
    autoRefreshFixedNote: '自動更新は60秒ごとに実行されます。',
  },
  'zh-cn': {
    usage: '使用量', visibility: '显示提供商', autoRefresh: '自动刷新',
    interval: '间隔 (秒)', language: '语言', refreshNow: '立即刷新',
    unavailable: '不可用', loading: '加载中…', noData: '无数据',
    hourly: '5小时', weekly: '7天', monthly: '每月',
    left: '剩余', resets: '重置', unlimited: '无限制',
    clickToRefresh: '点击刷新',
    group: '组', leftLabel: '剩余', resetLabel: '重置', resetsIn: '重置倒计时',
    autoRefreshOn: '自动刷新: 开', autoRefreshOff: '自动刷新: 关',
    dUnit: '天', hUnit: '时', mUnit: '分',
    noPercentData: '无数据', unknown: '未知',
    refreshing: '刷新中...',
    autoRefreshFixedNote: '自动刷新每60秒执行一次。',
  },
  'zh-tw': {
    usage: '使用量', visibility: '顯示提供商', autoRefresh: '自動重新整理',
    interval: '間隔 (秒)', language: '語言', refreshNow: '立即重新整理',
    unavailable: '無法使用', loading: '載入中…', noData: '無資料',
    hourly: '5小時', weekly: '7天', monthly: '每月',
    left: '剩餘', resets: '重設', unlimited: '無限制',
    clickToRefresh: '點擊重新整理',
    group: '群組', leftLabel: '剩餘', resetLabel: '重設', resetsIn: '重設倒數',
    autoRefreshOn: '自動重新整理: 開', autoRefreshOff: '自動重新整理: 關',
    dUnit: '天', hUnit: '時', mUnit: '分',
    noPercentData: '無資料', unknown: '未知',
    refreshing: '重新整理中...',
    autoRefreshFixedNote: '自動重新整理每60秒執行一次。',
  },
  fr: {
    usage: 'Utilisation', visibility: 'Afficher les fournisseurs', autoRefresh: 'Actualisation auto',
    interval: 'Intervalle (sec)', language: 'Langue', refreshNow: 'Actualiser',
    unavailable: 'Indisponible', loading: 'Chargement…', noData: 'Aucune donnée',
    hourly: '5h', weekly: '7j', monthly: 'Mensuel',
    left: 'restant', resets: 'réinit.', unlimited: 'Illimité',
    clickToRefresh: 'Cliquer pour actualiser',
    group: 'Groupe', leftLabel: 'Restant', resetLabel: 'Réinit.', resetsIn: 'Réinit. dans',
    autoRefreshOn: 'Actualisation auto : activée', autoRefreshOff: 'Actualisation auto : désactivée',
    dUnit: 'j', hUnit: 'h', mUnit: 'm',
    noPercentData: 'Aucune donnée', unknown: 'Inconnu',
    refreshing: 'Actualisation...',
    autoRefreshFixedNote: "L'actualisation auto s'exécute toutes les 60 secondes.",
  },
  de: {
    usage: 'Nutzung', visibility: 'Anbieter anzeigen', autoRefresh: 'Auto-Aktualisierung',
    interval: 'Intervall (Sek.)', language: 'Sprache', refreshNow: 'Jetzt aktualisieren',
    unavailable: 'Nicht verfügbar', loading: 'Lädt…', noData: 'Keine Daten',
    hourly: '5h', weekly: '7T', monthly: 'Monatlich',
    left: 'verbleibend', resets: 'zurückgesetzt', unlimited: 'Unbegrenzt',
    clickToRefresh: 'Zum Aktualisieren klicken',
    group: 'Gruppe', leftLabel: 'Verbleib.', resetLabel: 'Reset', resetsIn: 'Reset in',
    autoRefreshOn: 'Auto-Aktualisierung: EIN', autoRefreshOff: 'Auto-Aktualisierung: AUS',
    dUnit: 'T', hUnit: 'h', mUnit: 'm',
    noPercentData: 'Keine Daten', unknown: 'Unbekannt',
    refreshing: 'Aktualisierung...',
    autoRefreshFixedNote: 'Die Auto-Aktualisierung läuft alle 60 Sekunden.',
  },
  es: {
    usage: 'Uso', visibility: 'Mostrar proveedores', autoRefresh: 'Actualización automática',
    interval: 'Intervalo (seg)', language: 'Idioma', refreshNow: 'Actualizar ahora',
    unavailable: 'No disponible', loading: 'Cargando…', noData: 'Sin datos',
    hourly: '5h', weekly: '7d', monthly: 'Mensual',
    left: 'restante', resets: 'reinicia', unlimited: 'Ilimitado',
    clickToRefresh: 'Clic para actualizar',
    group: 'Grupo', leftLabel: 'Restante', resetLabel: 'Reinicio', resetsIn: 'Reinicia en',
    autoRefreshOn: 'Actualización auto: ON', autoRefreshOff: 'Actualización auto: OFF',
    dUnit: 'd', hUnit: 'h', mUnit: 'm',
    noPercentData: 'Sin datos', unknown: 'Desconocido',
    refreshing: 'Actualizando...',
    autoRefreshFixedNote: 'La actualización automática se ejecuta cada 60 segundos.',
  },
  pt: {
    usage: 'Uso', visibility: 'Mostrar provedores', autoRefresh: 'Atualização automática',
    interval: 'Intervalo (seg)', language: 'Idioma', refreshNow: 'Atualizar agora',
    unavailable: 'Indisponível', loading: 'Carregando…', noData: 'Sem dados',
    hourly: '5h', weekly: '7d', monthly: 'Mensal',
    left: 'restante', resets: 'reinicia', unlimited: 'Ilimitado',
    clickToRefresh: 'Clique para atualizar',
    group: 'Grupo', leftLabel: 'Restante', resetLabel: 'Reinício', resetsIn: 'Reinicia em',
    autoRefreshOn: 'Atualização auto: ON', autoRefreshOff: 'Atualização auto: OFF',
    dUnit: 'd', hUnit: 'h', mUnit: 'm',
    noPercentData: 'Sem dados', unknown: 'Desconhecido',
    refreshing: 'Atualizando...',
    autoRefreshFixedNote: 'A atualização automática é executada a cada 60 segundos.',
  },
  ru: {
    usage: 'Использование', visibility: 'Показать провайдеров', autoRefresh: 'Авто-обновление',
    interval: 'Интервал (сек)', language: 'Язык', refreshNow: 'Обновить',
    unavailable: 'Недоступно', loading: 'Загрузка…', noData: 'Нет данных',
    hourly: '5ч', weekly: '7д', monthly: 'Месяц',
    left: 'осталось', resets: 'сброс', unlimited: 'Без ограничений',
    clickToRefresh: 'Нажмите для обновления',
    group: 'Группа', leftLabel: 'Осталось', resetLabel: 'Сброс', resetsIn: 'Сброс через',
    autoRefreshOn: 'Авто-обновление: ВКЛ', autoRefreshOff: 'Авто-обновление: ВЫКЛ',
    dUnit: 'д', hUnit: 'ч', mUnit: 'м',
    noPercentData: 'Нет данных', unknown: 'Неизвестно',
    refreshing: 'Обновление...',
    autoRefreshFixedNote: 'Авто-обновление выполняется каждые 60 секунд.',
  },
  it: {
    usage: 'Utilizzo', visibility: 'Mostra provider', autoRefresh: 'Aggiorn. automatico',
    interval: 'Intervallo (sec)', language: 'Lingua', refreshNow: 'Aggiorna ora',
    unavailable: 'Non disponibile', loading: 'Caricamento…', noData: 'Nessun dato',
    hourly: '5h', weekly: '7g', monthly: 'Mensile',
    left: 'rimanente', resets: 'reset', unlimited: 'Illimitato',
    clickToRefresh: 'Clic per aggiornare',
    group: 'Gruppo', leftLabel: 'Rimanente', resetLabel: 'Reset', resetsIn: 'Reset in',
    autoRefreshOn: 'Aggiorn. auto: ON', autoRefreshOff: 'Aggiorn. auto: OFF',
    dUnit: 'g', hUnit: 'h', mUnit: 'm',
    noPercentData: 'Nessun dato', unknown: 'Sconosciuto',
    refreshing: 'Aggiornamento...',
    autoRefreshFixedNote: "L'aggiornamento automatico viene eseguito ogni 60 secondi.",
  },
  tr: {
    usage: 'Kullanım', visibility: 'Sağlayıcıları Göster', autoRefresh: 'Otomatik Yenile',
    interval: 'Aralık (sn)', language: 'Dil', refreshNow: 'Şimdi Yenile',
    unavailable: 'Kullanılamaz', loading: 'Yükleniyor…', noData: 'Veri Yok',
    hourly: '5s', weekly: '7g', monthly: 'Aylık',
    left: 'kaldı', resets: 'sıfırlanır', unlimited: 'Sınırsız',
    clickToRefresh: 'Yenilemek için tıkla',
    group: 'Grup', leftLabel: 'Kalan', resetLabel: 'Sıfırlama', resetsIn: 'Sıfırlanma',
    autoRefreshOn: 'Otomatik Yenile: AÇIK', autoRefreshOff: 'Otomatik Yenile: KAPALI',
    dUnit: 'g', hUnit: 's', mUnit: 'd',
    noPercentData: 'Veri Yok', unknown: 'Bilinmiyor',
    refreshing: 'Yenileniyor...',
    autoRefreshFixedNote: 'Otomatik yenileme her 60 saniyede bir çalışır.',
  },
  pl: {
    usage: 'Użycie', visibility: 'Pokaż dostawców', autoRefresh: 'Auto-odświeżanie',
    interval: 'Interwał (sek)', language: 'Język', refreshNow: 'Odśwież teraz',
    unavailable: 'Niedostępny', loading: 'Ładowanie…', noData: 'Brak danych',
    hourly: '5h', weekly: '7d', monthly: 'Miesięcznie',
    left: 'pozostało', resets: 'reset', unlimited: 'Nieograniczony',
    clickToRefresh: 'Kliknij, aby odświeżyć',
    group: 'Grupa', leftLabel: 'Pozostało', resetLabel: 'Reset', resetsIn: 'Reset za',
    autoRefreshOn: 'Auto-odśw.: WŁ', autoRefreshOff: 'Auto-odśw.: WYŁ',
    dUnit: 'd', hUnit: 'h', mUnit: 'm',
    noPercentData: 'Brak danych', unknown: 'Nieznany',
    refreshing: 'Odświeżanie...',
    autoRefreshFixedNote: 'Automatyczne odświeżanie działa co 60 sekund.',
  },
  nl: {
    usage: 'Gebruik', visibility: 'Providers weergeven', autoRefresh: 'Auto-vernieuwen',
    interval: 'Interval (sec)', language: 'Taal', refreshNow: 'Nu vernieuwen',
    unavailable: 'Niet beschikbaar', loading: 'Laden…', noData: 'Geen gegevens',
    hourly: '5u', weekly: '7d', monthly: 'Maandelijks',
    left: 'resterend', resets: 'reset', unlimited: 'Onbeperkt',
    clickToRefresh: 'Klik om te vernieuwen',
    group: 'Groep', leftLabel: 'Resterend', resetLabel: 'Reset', resetsIn: 'Reset in',
    autoRefreshOn: 'Auto-vernieuwen: AAN', autoRefreshOff: 'Auto-vernieuwen: UIT',
    dUnit: 'd', hUnit: 'u', mUnit: 'm',
    noPercentData: 'Geen gegevens', unknown: 'Onbekend',
    refreshing: 'Vernieuwen...',
    autoRefreshFixedNote: 'Automatisch vernieuwen wordt elke 60 seconden uitgevoerd.',
  },
  vi: {
    usage: 'Sử dụng', visibility: 'Hiển thị nhà cung cấp', autoRefresh: 'Tự động làm mới',
    interval: 'Khoảng thời gian (giây)', language: 'Ngôn ngữ', refreshNow: 'Làm mới ngay',
    unavailable: 'Không khả dụng', loading: 'Đang tải…', noData: 'Không có dữ liệu',
    hourly: '5 giờ', weekly: '7 ngày', monthly: 'Hàng tháng',
    left: 'còn lại', resets: 'đặt lại', unlimited: 'Không giới hạn',
    clickToRefresh: 'Nhấp để làm mới',
    group: 'Nhóm', leftLabel: 'Còn lại', resetLabel: 'Đặt lại', resetsIn: 'Đặt lại sau',
    autoRefreshOn: 'Tự động làm mới: BẬT', autoRefreshOff: 'Tự động làm mới: TẮT',
    dUnit: 'ng', hUnit: 'g', mUnit: 'ph',
    noPercentData: 'Không có dữ liệu', unknown: 'Không rõ',
    refreshing: 'Đang làm mới...',
    autoRefreshFixedNote: 'Tự động làm mới chạy mỗi 60 giây.',
  },
  id: {
    usage: 'Penggunaan', visibility: 'Tampilkan Penyedia', autoRefresh: 'Perbarui Otomatis',
    interval: 'Interval (det)', language: 'Bahasa', refreshNow: 'Perbarui Sekarang',
    unavailable: 'Tidak tersedia', loading: 'Memuat…', noData: 'Tidak ada data',
    hourly: '5j', weekly: '7h', monthly: 'Bulanan',
    left: 'tersisa', resets: 'diatur ulang', unlimited: 'Tak terbatas',
    clickToRefresh: 'Klik untuk memperbarui',
    group: 'Grup', leftLabel: 'Tersisa', resetLabel: 'Atur Ulang', resetsIn: 'Atur ulang dalam',
    autoRefreshOn: 'Perbarui Otomatis: ON', autoRefreshOff: 'Perbarui Otomatis: OFF',
    dUnit: 'h', hUnit: 'j', mUnit: 'm',
    noPercentData: 'Tidak ada data', unknown: 'Tidak diketahui',
    refreshing: 'Menyegarkan...',
    autoRefreshFixedNote: 'Penyegaran otomatis berjalan setiap 60 detik.',
  },
};

class SettingsPanelProvider {
  static viewType = 'aiUsage.settingsPanel';

  constructor(context, getLastResults, output) {
    this._context = context;
    this._getLastResults = getLastResults;
    this._output = output;
    this._view = null;
  }

  postResults(results) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'results', data: results });
    }
  }

  postRefreshState(state) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'refreshState', state });
    }
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._buildHtml();

    // 패널이 열릴 때 이미 있는 결과 즉시 전송
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        const r = this._getLastResults?.();
        if (r) this.postResults(r);
      }
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      this._output?.appendLine(`[panel] message type=${String(msg?.type || '')}`);
      if (msg.type === 'update') {
        const key = String(msg.key || '');
        const value = msg.value;
        const cfgBefore = getConfig();
        this._output?.appendLine(`[panel] update request key=${key} value=${JSON.stringify(value)}`);
        try {
          await vscode.workspace.getConfiguration().update(
            key, value, vscode.ConfigurationTarget.Global
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const isGeminiToggleKey =
            key === 'geminiUsage.enabled' ||
            key === 'geminiUsage.showPro' ||
            key === 'geminiUsage.showFlash' ||
            key === 'geminiUsage.showFlashLite';
          const looksUnregistered =
            message.includes('등록된 구성이 아니므로') ||
            message.toLowerCase().includes('not a registered configuration');
          if (isGeminiToggleKey && looksUnregistered) {
            await this._context.globalState.update(`fallback.${key}`, !!value);
            this._output?.appendLine(`[panel] update fallback saved key=${key} value=${JSON.stringify(!!value)}`);
          } else {
            this._output?.appendLine(`[panel] update failed key=${key}: ${message}`);
            return;
          }
        }
        const cfgAfter = getConfig();
        this._output?.appendLine(
          `[panel] update applied key=${key} geminiShow={pro:${cfgBefore.geminiShowPro}->${cfgAfter.geminiShowPro},flash:${cfgBefore.geminiShowFlash}->${cfgAfter.geminiShowFlash},flashLite:${cfgBefore.geminiShowFlashLite}->${cfgAfter.geminiShowFlashLite}}`
        );
        if (
          key === 'geminiUsage.enabled' ||
          key === 'geminiUsage.showPro' ||
          key === 'geminiUsage.showFlash' ||
          key === 'geminiUsage.showFlashLite'
        ) {
          this._output?.appendLine('[panel] forcing gemini statusbar rebuild from cache');
          await vscode.commands.executeCommand('codexUsage.refreshGeminiFromCache');
          setTimeout(() => { void vscode.commands.executeCommand('codexUsage.refreshGeminiFromCache'); }, 120);
          setTimeout(() => { void vscode.commands.executeCommand('codexUsage.refreshGeminiFromCache'); }, 300);
        }
      } else if (msg.type === 'ready') {
        const r = this._getLastResults?.();
        if (r) this.postResults(r);
        // 첫 로드 시 캐시가 비어 있으면 즉시 1회 새로고침하여 로딩 고착 방지
        if (!r || (!r.codex && !r.claude && !r.copilot && !r.gemini)) {
          vscode.commands.executeCommand('codexUsage.refresh');
        }
      } else if (msg.type === 'refresh') {
        vscode.commands.executeCommand('codexUsage.refresh');
      } else if (msg.type === 'refreshProvider') {
        const provider = String(msg.provider || '').toLowerCase();
        if (provider === 'codex') vscode.commands.executeCommand('codexUsage.refreshCodex');
        else if (provider === 'claude') vscode.commands.executeCommand('codexUsage.refreshClaude');
        else if (provider === 'copilot') vscode.commands.executeCommand('codexUsage.refreshCopilot');
        else if (provider === 'gemini') vscode.commands.executeCommand('codexUsage.refreshGemini');
      }
    }, undefined, this._context.subscriptions);

    vscode.workspace.onDidChangeConfiguration((e) => {
      // 패널 전체 재렌더는 언어 변경시에만 수행 (깜빡임 방지)
      if (e.affectsConfiguration('aiUsage.language')) {
        if (this._view) {
          this._view.webview.html = this._buildHtml();
          // HTML 재빌드 후 기존 결과 즉시 재전송
          const r = this._getLastResults?.();
          if (r) this.postResults(r);
        }
      }
    }, undefined, this._context.subscriptions);
  }

  _buildHtml() {
    const cfg = getConfig();
    const t = I18N[cfg.language] || I18N.ko;
    const chk = (val) => val ? 'checked' : '';
    const sel = (a, b) => a === b ? 'selected' : '';

    return `<!DOCTYPE html>
<html lang="${cfg.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; }
  body {
    padding: 6px 8px 10px;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: transparent;
    margin: 0;
  }
  .section { margin-bottom: 8px; }
  .section-title {
    font-size: 10px; font-weight: 600; letter-spacing: 0.8px;
    text-transform: uppercase;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
    margin-bottom: 4px; padding-bottom: 3px;
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
  }
  /* 사용량 카드 */
  .usage-card {
    padding: 6px 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .usage-card:last-child { border-bottom: none; }
  .usage-header {
    display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
  }
  .provider-name { font-weight: 600; flex: 1; }
  .provider-refresh-btn {
    width: auto;
    min-width: 0;
    padding: 2px 6px;
    font-size: 10px;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
  }
  .window-row { margin-bottom: 5px; }
  .window-row:last-child { margin-bottom: 0; }
  .window-meta {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 2px;
  }
  .window-label { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .window-stat { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .track {
    height: 3px; border-radius: 2px;
    background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.2));
  }
  .bar {
    height: 3px; border-radius: 2px;
    background: var(--vscode-progressBar-background, #0e70c0);
    transition: width 0.4s ease;
  }
  .bar.warn { background: #cca700; }
  .bar.danger { background: #f14c4c; }
  .usage-text {
    font-size: 11px; color: var(--vscode-descriptionForeground); padding: 2px 0;
  }
  .usage-loading { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 0; }
  /* 체크박스 항목 */
  .item {
    display: flex; align-items: center; gap: 8px;
    padding: 2px 2px; border-radius: 3px; cursor: pointer;
  }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item input[type="checkbox"] {
    width: 14px; height: 14px; cursor: pointer; flex-shrink: 0;
    accent-color: var(--vscode-focusBorder);
  }
  .item label {
    cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 6px; flex: 1;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot-blue  { background: #4fc1ff; }
  .dot-red   { background: #f48771; }
  .dot-green { background: #4ec9b0; }
  .dot-yellow { background: #d7ba7d; }
  /* 숫자/셀렉트 행 */
  .row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 2px 2px; gap: 6px;
  }
  .row label { flex: 1; }
  input[type="number"], select {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 3px 6px; border-radius: 2px;
    font-size: var(--vscode-font-size);
    font-family: var(--vscode-font-family);
  }
  input[type="number"] { width: 60px; text-align: right; }
  select { min-width: 80px; }
  input[type="number"]:focus, select:focus {
    outline: 1px solid var(--vscode-focusBorder);
    border-color: var(--vscode-focusBorder);
  }
  button {
    width: 100%; padding: 5px 8px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; cursor: pointer; border-radius: 2px;
    font-size: var(--vscode-font-size);
    font-family: var(--vscode-font-family);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:active { opacity: 0.8; }
  button:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }
  .refresh-spinner {
    width: 11px;
    height: 11px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    display: none;
    flex-shrink: 0;
  }
  button.refreshing .refresh-spinner {
    display: inline-block;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
</head>
<body>

<!-- 표시 항목 -->
<div class="section">
  <div class="section-title">${t.visibility}</div>
  <div class="item" onclick="toggleCheck('codex')">
    <input type="checkbox" id="codex" ${chk(cfg.codexEnabled)}
      onclick="event.stopPropagation(); toggle('codexUsage.enabled', this.checked)">
    <label for="codex" onclick="event.preventDefault()">
      <span class="dot dot-blue"></span>Codex
    </label>
  </div>
  <div class="item" onclick="toggleCheck('claude')">
    <input type="checkbox" id="claude" ${chk(cfg.claudeEnabled)}
      onclick="event.stopPropagation(); toggle('claudeUsage.enabled', this.checked)">
    <label for="claude" onclick="event.preventDefault()">
      <span class="dot dot-red"></span>Claude
    </label>
  </div>
  <div class="item" onclick="toggleCheck('copilot')">
    <input type="checkbox" id="copilot" ${chk(cfg.copilotEnabled)}
      onclick="event.stopPropagation(); toggle('copilotUsage.enabled', this.checked)">
    <label for="copilot" onclick="event.preventDefault()">
      <span class="dot dot-green"></span>Copilot
    </label>
  </div>
  <div class="item" onclick="toggleCheck('gemini')">
    <input type="checkbox" id="gemini" ${chk(cfg.geminiEnabled)}
      onclick="event.stopPropagation(); toggle('geminiUsage.enabled', this.checked)">
    <label for="gemini" onclick="event.preventDefault()">
      <span class="dot dot-yellow"></span>Gemini
    </label>
  </div>
</div>

<!-- 사용량 -->
<div class="section">
  <div class="section-title">${t.usage}</div>
  <div id="usage-area"></div>
</div>

<div class="section">
  <div class="section-title">${t.visibility} (Gemini)</div>
  <div class="item" onclick="toggleCheck('geminiPro')">
    <input type="checkbox" id="geminiPro" ${chk(cfg.geminiShowPro)}
      onclick="event.stopPropagation(); toggle('geminiUsage.showPro', this.checked)">
    <label for="geminiPro" onclick="event.preventDefault()">Pro</label>
  </div>
  <div class="item" onclick="toggleCheck('geminiFlash')">
    <input type="checkbox" id="geminiFlash" ${chk(cfg.geminiShowFlash)}
      onclick="event.stopPropagation(); toggle('geminiUsage.showFlash', this.checked)">
    <label for="geminiFlash" onclick="event.preventDefault()">Flash</label>
  </div>
  <div class="item" onclick="toggleCheck('geminiFlashLite')">
    <input type="checkbox" id="geminiFlashLite" ${chk(cfg.geminiShowFlashLite)}
      onclick="event.stopPropagation(); toggle('geminiUsage.showFlashLite', this.checked)">
    <label for="geminiFlashLite" onclick="event.preventDefault()">Flash Lite</label>
  </div>
</div>

<div class="section">
  <div class="usage-text">${t.autoRefreshFixedNote}</div>
</div>

<!-- 언어 -->
<div class="section">
  <div class="section-title">${t.language}</div>
  <div class="row">
    <label for="lang">${t.language}</label>
    <select id="lang" onchange="update('aiUsage.language', this.value)">
      <option value="en" ${sel(cfg.language,'en')}>English</option>
      <option value="ko" ${sel(cfg.language,'ko')}>한국어</option>
      <option value="ja" ${sel(cfg.language,'ja')}>日本語</option>
      <option value="zh-cn" ${sel(cfg.language,'zh-cn')}>中文(简体)</option>
      <option value="zh-tw" ${sel(cfg.language,'zh-tw')}>中文(繁體)</option>
      <option value="fr" ${sel(cfg.language,'fr')}>Français</option>
      <option value="de" ${sel(cfg.language,'de')}>Deutsch</option>
      <option value="es" ${sel(cfg.language,'es')}>Español</option>
      <option value="pt" ${sel(cfg.language,'pt')}>Português</option>
      <option value="ru" ${sel(cfg.language,'ru')}>Русский</option>
      <option value="it" ${sel(cfg.language,'it')}>Italiano</option>
      <option value="tr" ${sel(cfg.language,'tr')}>Türkçe</option>
      <option value="pl" ${sel(cfg.language,'pl')}>Polski</option>
      <option value="nl" ${sel(cfg.language,'nl')}>Nederlands</option>
      <option value="vi" ${sel(cfg.language,'vi')}>Tiếng Việt</option>
      <option value="id" ${sel(cfg.language,'id')}>Bahasa Indonesia</option>
    </select>
  </div>
</div>

<button id="refresh-btn" onclick="refresh()"><span id="refresh-spinner" class="refresh-spinner" aria-hidden="true"></span><span id="refresh-label">${t.refreshNow}</span></button>

<script>
const vscode = acquireVsCodeApi();
const T = ${JSON.stringify(t)};
const INITIAL_RESULTS = ${JSON.stringify(this._getLastResults?.() || { codex: null, claude: null, copilot: null, gemini: null })};
let CURRENT_RESULTS = INITIAL_RESULTS;
let REFRESH_STATE = { all: false, providers: { codex: false, claude: false, copilot: false, gemini: false } };

function toggle(key, value) { vscode.postMessage({ type: 'update', key, value }); }
function update(key, value) { vscode.postMessage({ type: 'update', key, value }); }
function refresh() {
  if (REFRESH_STATE.all) return;
  vscode.postMessage({ type: 'refresh' });
}
function refreshProvider(provider) {
  const p = String(provider || '').toLowerCase();
  if (!p) return;
  if (REFRESH_STATE.all || REFRESH_STATE.providers[p]) return;
  vscode.postMessage({ type: 'refreshProvider', provider: p });
}
function setButtonRefreshing(btnId, labelId, refreshing, baseText) {
  const btn = document.getElementById(btnId);
  const label = document.getElementById(labelId);
  if (!btn || !label) return;
  btn.disabled = !!refreshing;
  label.textContent = refreshing ? T.refreshing : baseText;
  if (refreshing) btn.classList.add('refreshing');
  else btn.classList.remove('refreshing');
}
function setRefreshingState(state) {
  REFRESH_STATE = state || { all: false, providers: { codex: false, claude: false, copilot: false, gemini: false } };
  const p = REFRESH_STATE.providers || {};
  setButtonRefreshing('refresh-btn', 'refresh-label', !!REFRESH_STATE.all, T.refreshNow);
  setButtonRefreshing('refresh-btn-codex', 'refresh-label-codex', !!REFRESH_STATE.all || !!p.codex, T.refreshNow);
  setButtonRefreshing('refresh-btn-claude', 'refresh-label-claude', !!REFRESH_STATE.all || !!p.claude, T.refreshNow);
  setButtonRefreshing('refresh-btn-copilot', 'refresh-label-copilot', !!REFRESH_STATE.all || !!p.copilot, T.refreshNow);
  setButtonRefreshing('refresh-btn-gemini', 'refresh-label-gemini', !!REFRESH_STATE.all || !!p.gemini, T.refreshNow);
}
function toggleCheck(id) {
  const el = document.getElementById(id);
  el.checked = !el.checked;
  const keyMap = {
    codex: 'codexUsage.enabled', claude: 'claudeUsage.enabled',
    copilot: 'copilotUsage.enabled',
    gemini: 'geminiUsage.enabled',
    geminiFlashLite: 'geminiUsage.showFlashLite',
    geminiFlash: 'geminiUsage.showFlash',
    geminiPro: 'geminiUsage.showPro',
  };
  toggle(keyMap[id], el.checked);
  renderUsage(CURRENT_RESULTS);
}

// ── 사용량 렌더링 ──────────────────────────────────────────
window.addEventListener('message', (e) => {
  if (e.data?.type === 'results') {
    CURRENT_RESULTS = e.data.data || {};
    renderUsage(CURRENT_RESULTS);
  } else if (e.data?.type === 'refreshState') {
    setRefreshingState(e.data.state);
  }
});
// 웹뷰 준비 완료 신호: 초기 결과/새로고침 트리거 동기화
vscode.postMessage({ type: 'ready' });

function isProviderEnabled(id) {
  const el = document.getElementById(id);
  return !!el?.checked;
}

function timeLeft(epochSec) {
  if (typeof epochSec !== 'number') return null;
  const diff = epochSec * 1000 - Date.now();
  if (diff <= 0) return null;
  const m = Math.floor(diff / 60000);
  return { d: Math.floor(m/1440), h: Math.floor((m%1440)/60), m: m%60 };
}
function fmtTime(t) {
  if (!t) return '-';
  if (t.d > 0) return t.d + T.dUnit + ' ' + t.h + T.hUnit;
  return t.h + T.hUnit + ' ' + t.m + T.mUnit;
}
function leftPct(usedPct) {
  if (typeof usedPct !== 'number') return null;
  return Math.max(0, Math.min(100, Math.round((100 - usedPct) * 10) / 10));
}
function barClass(pct) {
  if (pct === null) return '';
  if (pct <= 10) return ' danger';
  if (pct <= 25) return ' warn';
  return '';
}
function windowRow(label, usedPct, resetEpoch) {
  const lp = leftPct(usedPct);
  const w = lp !== null ? lp : 0;
  const bc = barClass(lp);
  const time = fmtTime(timeLeft(resetEpoch));
  const pctTxt = lp !== null ? lp + '%' : 'Full';
  return '<div class="window-row">'
    + '<div class="window-meta"><span class="window-label">' + label + '</span>'
    + '<span class="window-stat">' + pctTxt + ' ' + T.left + ' · ' + time + '</span></div>'
    + '<div class="track"><div class="bar' + bc + '" style="width:' + w + '%"></div></div>'
    + '</div>';
}

function cardHtml(dotClass, name, result) {
  const providerId = String(name || '').toLowerCase();
  const refreshBtn = '<button id="refresh-btn-' + providerId + '" class="provider-refresh-btn" onclick="refreshProvider(\\'' + providerId + '\\')">'
    + '<span id="refresh-spinner-' + providerId + '" class="refresh-spinner" aria-hidden="true"></span>'
    + '<span id="refresh-label-' + providerId + '">' + T.refreshNow + '</span></button>';
  let body = '';
  if (!result) {
    body = '<div class="usage-text">' + T.loading + '</div>';
  } else if (!result.ok) {
    body = '<div class="usage-text">⚠ ' + T.unavailable + '</div>';
  } else if (Array.isArray(result.geminiModels)) {
    result.geminiModels.forEach(m => {
      const lp = typeof m.leftPercent === 'number' ? m.leftPercent : null;
      const w = lp !== null ? lp : 100;
      const bc = barClass(lp);
      const time = fmtTime(timeLeft(m.resetsAt));
      const pctTxt = lp !== null ? lp + '%' : 'Full';
      body += '<div class="window-row">'
        + '<div class="window-meta"><span class="window-label">' + m.label + '</span>'
        + '<span class="window-stat">' + pctTxt + ' ' + T.left + ' · ' + time + '</span></div>'
        + '<div class="track"><div class="bar' + bc + '" style="width:' + w + '%"></div></div>'
        + '</div>';
    });
  } else if (result.groups && result.groups.length > 0) {
    result.groups.forEach(g => {
      const p = g.rateLimits?.primary;
      const s = g.rateLimits?.secondary;
      if (result.groups.length > 1) body += '<div class="usage-text" style="font-size:10px;color:var(--vscode-descriptionForeground)">' + g.label + '</div>';
      if (p) body += windowRow(T.hourly, p.used_percent, p.resets_at);
      if (s) body += windowRow(T.weekly, s.used_percent, s.resets_at);
    });
  } else if (result.rateLimits) {
    const p = result.rateLimits.primary;
    const s = result.rateLimits.secondary;
    if (p) body += windowRow(T.hourly, p.used_percent, p.resets_at);
    if (s) body += windowRow(T.weekly, s.used_percent, s.resets_at);
  } else if (result.quota) {
    const q = result.quota;
    if (q.unlimited) {
      body = '<div class="usage-text">' + T.unlimited + '</div>';
    } else {
      const lp = q.leftPercent;
      const w = lp !== null ? lp : 0;
      const bc = barClass(lp);
      const time = fmtTime(timeLeft(q.resetsAt));
      body = '<div class="window-row">'
        + '<div class="window-meta"><span class="window-label">' + T.monthly + '</span>'
        + '<span class="window-stat">' + (lp !== null ? lp + '%' : 'Full') + ' ' + T.left + ' · ' + time + '</span></div>'
        + '<div class="track"><div class="bar' + bc + '" style="width:' + w + '%"></div></div>'
        + '</div>';
    }
  } else {
    body = '<div class="usage-text">' + (result.summary || T.noData) + '</div>';
  }
  return '<div class="usage-card">'
    + '<div class="usage-header"><span class="dot ' + dotClass + '"></span>'
    + '<span class="provider-name">' + name + '</span>' + refreshBtn + '</div>'
    + body + '</div>';
}

function renderUsage(data) {
  const area = document.getElementById('usage-area');
  if (!area) return;
  const d = data || {};
  let html = '';
  if (isProviderEnabled('codex')) html += cardHtml('dot-blue','Codex',d.codex);
  if (isProviderEnabled('claude')) html += cardHtml('dot-red','Claude',d.claude);
  if (isProviderEnabled('copilot')) html += cardHtml('dot-green','Copilot',d.copilot);
  if (isProviderEnabled('gemini')) html += cardHtml('dot-yellow','Gemini',d.gemini);
  area.innerHTML = html || '<div class="usage-text">' + T.noData + '</div>';
}

// 초기 렌더: 로딩 문구 없이 마지막 결과 우선 표시
renderUsage(INITIAL_RESULTS);
</script>
</body>
</html>`;
  }
}

function deactivate() {
  // Nothing to clean up explicitly; subscriptions are disposed by VS Code.
}

function normalizeLanguage(language) {
  if (!language || typeof language !== 'string') return 'en';
  const raw = language.toLowerCase();
  if (SUPPORTED_LANGUAGES.has(raw)) return raw;
  if (raw === 'zh-hans') return 'zh-cn';
  if (raw === 'zh-hant' || raw === 'zh-hk') return 'zh-tw';
  const base = raw.split('-')[0];
  if (SUPPORTED_LANGUAGES.has(base)) return base;
  return 'en';
}

function getEffectiveLanguage(config) {
  const inspected = config.inspect('aiUsage.language');
  const explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  if (typeof explicit === 'string' && explicit.trim()) {
    return normalizeLanguage(explicit);
  }
  return normalizeLanguage(vscode.env.language);
}

async function ensureInitialLanguageSetting() {
  const config = vscode.workspace.getConfiguration();
  const inspected = config.inspect('aiUsage.language');
  const hasExplicit =
    inspected?.workspaceFolderValue !== undefined ||
    inspected?.workspaceValue !== undefined ||
    inspected?.globalValue !== undefined;

  if (hasExplicit) return;

  const initial = normalizeLanguage(vscode.env.language);
  await config.update('aiUsage.language', initial, vscode.ConfigurationTarget.Global);
}

function getConfig() {
  const config = vscode.workspace.getConfiguration();
  return {
    language: getEffectiveLanguage(config),
    codexEnabled: config.get('codexUsage.enabled', true),
    claudeEnabled: config.get('claudeUsage.enabled', true),
    copilotEnabled: config.get('copilotUsage.enabled', true),
    geminiEnabled: getGeminiToggleValue(config, 'geminiUsage.enabled', true),
    geminiShowFlashLite: getGeminiToggleValue(config, 'geminiUsage.showFlashLite', true),
    geminiShowFlash: getGeminiToggleValue(config, 'geminiUsage.showFlash', true),
    geminiShowPro: getGeminiToggleValue(config, 'geminiUsage.showPro', true),
    source: config.get('codexUsage.source', 'auto'),
    command: config.get('codexUsage.command', 'codex usage'),
    commandTimeoutMs: config.get('codexUsage.commandTimeoutMs', 10000),
    sessionsRoot: config.get('codexUsage.sessionsRoot', '~/.codex/sessions'),
    claudeSessionsRoot: config.get('claudeUsage.sessionsRoot', '~/.claude/projects'),
    claudeCommand: config.get('claudeUsage.command', ''),
    claudeCommandTimeoutMs: config.get('claudeUsage.commandTimeoutMs', 8000),
    copilotCommandTimeoutMs: config.get('copilotUsage.commandTimeoutMs', 8000),
  };
}

async function fetchUsage(output) {
  const cfg = getConfig();
  if (cfg.source === 'command') {
    return fetchUsageFromCommand(cfg, output);
  }

  if (cfg.source === 'sessionLog') {
    return fetchUsageFromSessionLog(cfg, output);
  }

  const commandResult = await fetchUsageFromCommand(cfg, output);
  if (commandResult.ok) {
    return commandResult;
  }

  output.appendLine(`[info] command source failed (${commandResult.error}), trying session log fallback`);
  const sessionResult = await fetchUsageFromSessionLog(cfg, output);
  if (sessionResult.ok) {
    return sessionResult;
  }

  return {
    ok: false,
    error: `command failed: ${commandResult.error}; session log failed: ${sessionResult.error}`,
  };
}

async function fetchClaudeUsage(output) {
  try {
    const cfg = getConfig();
    // Restore persisted cache on first run (survives VS Code restarts)
    if (!lastClaudeRateLimitResult && extensionState) {
      const persisted = extensionState.get('claude.lastRateLimitResult');
      if (persisted?.ok) {
        lastClaudeRateLimitResult = persisted;
        output.appendLine('[info:claude] restored last rate limit result from persistent cache');
      }
    }

    const projectsRoot = expandHome(cfg.claudeSessionsRoot);
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');

    // ── 1순위: 로컬 JSONL 토큰 카운트 ──────────────────────────────────────
    // 최근 5시간 내 Claude Code 세션 데이터가 있으면 API 호출 없이 바로 표시
    const tokenResult = buildClaudeRateLimitsFromLocalTokenCount(projectsRoot, credPath, output);
    if (tokenResult) {
      output.appendLine(`[info:claude] local token count: ${tokenResult.usedTokens}/${tokenResult.planLimit} tokens`);
      lastClaudeRateLimitResult = tokenResult.result;
      extensionState?.update('claude.lastRateLimitResult', tokenResult.result);
      return tokenResult.result;
    }

    // ── 2순위: 로컬 JSONL rate_limits 필드 (Claude Code가 기록하는 경우) ───
    if (cfg.claudeCommand && cfg.claudeCommand.trim()) {
      const cmdResult = await fetchSimpleCommandUsage(
        'claudeUsage.command',
        'claudeUsage.commandTimeoutMs',
        output,
        'claude'
      );
      if (cmdResult.ok) {
        return cmdResult;
      }
      output.appendLine(`[info:claude] command failed: ${cmdResult.error}`);
    }

    const sessionHit = findNewestClaudeSessionWithRateLimits(projectsRoot, 20);
    if (sessionHit) {
      output.appendLine(`[run:claude-session] ${sessionHit.filePath}`);
      const summary = formatRateLimitSingleWindowSummary(sessionHit.rateLimits);
      const raw = `Claude H/W left\n${formatRateLimitRaw(sessionHit.rateLimits)}`;
      const result = {
        ok: true,
        summary,
        raw,
        sourceLabel: 'Source: local session rate limits',
        rateLimits: sessionHit.rateLimits,
        groups: [{ label: 'Claude', rateLimits: sessionHit.rateLimits }],
      };
      lastClaudeRateLimitResult = result;
      extensionState?.update('claude.lastRateLimitResult', result);
      return result;
    }

    // ── 3순위: OAuth API (로컬에 데이터 없을 때만 호출) ─────────────────────
    const MAX_COOLDOWN_MS = 30 * 60 * 1000;

    // 5분 이내 성공 캐시가 있으면 API 재호출 스킵
    if (lastClaudeOauthSuccessAt && Date.now() - lastClaudeOauthSuccessAt < CLAUDE_OAUTH_MIN_INTERVAL_MS) {
      if (lastClaudeRateLimitResult?.ok) {
        const ageSec = Math.round((Date.now() - lastClaudeOauthSuccessAt) / 1000);
        output.appendLine(`[info:claude] using cached API result (${ageSec}s old)`);
        return { ...lastClaudeRateLimitResult, sourceLabel: `${lastClaudeRateLimitResult.sourceLabel} (cached)` };
      }
    }

    // 429 쿨다운 중이면 API 스킵
    let oauthResult = null;
    if (lastClaudeOauth429At && Date.now() - lastClaudeOauth429At < lastClaudeOauth429RetryAfterMs) {
      const remainSec = Math.ceil((lastClaudeOauth429RetryAfterMs - (Date.now() - lastClaudeOauth429At)) / 1000);
      output.appendLine(`[info:claude] oauth 429 cooldown active (${remainSec}s remaining, cooldown=${Math.round(lastClaudeOauth429RetryAfterMs/60000)}min)`);
      oauthResult = { ok: false, error: 'HTTP 429: rate limit cooldown active' };
    } else {
      for (let attempt = 1; attempt <= PROVIDER_MAX_RETRY_ATTEMPTS; attempt += 1) {
        oauthResult = await fetchClaudeUsageFromOauth(output);
        if (oauthResult.ok) {
          lastClaudeRateLimitResult = oauthResult;
          lastClaudeOauth429At = 0;
          lastClaudeOauth429RetryAfterMs = 5 * 60 * 1000;
          lastClaudeOauthSuccessAt = Date.now();
          extensionState?.update('claude.lastRateLimitResult', oauthResult);
          return oauthResult;
        }
        output.appendLine(`[info:claude] oauth failed (attempt ${attempt}/${PROVIDER_MAX_RETRY_ATTEMPTS}): ${oauthResult.error}`);
        if (isClaudeRateLimitError(oauthResult.error)) {
          const retryAfterMatch = oauthResult.error.match(/retry.after[:\s]+([\d]+)/i);
          const retryAfterSec = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : null;
          if (retryAfterSec && retryAfterSec > 0) {
            lastClaudeOauth429RetryAfterMs = retryAfterSec * 1000;
          } else {
            lastClaudeOauth429RetryAfterMs = Math.min(lastClaudeOauth429RetryAfterMs * 2, MAX_COOLDOWN_MS);
          }
          lastClaudeOauth429At = Date.now();
          const cooldownMin = Math.round(lastClaudeOauth429RetryAfterMs / 60000);
          output.appendLine(`[info:claude] oauth 429 received, entering ${cooldownMin}-min cooldown`);
          break;
        }
        if (!isClaudeTransientError(oauthResult.error) || attempt >= PROVIDER_MAX_RETRY_ATTEMPTS) {
          break;
        }
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }

    // API 실패 시 캐시 반환
    if ((isClaudeTransientError(oauthResult?.error) || isClaudeRateLimitError(oauthResult?.error)) && lastClaudeRateLimitResult?.ok) {
      const reason = isClaudeRateLimitError(oauthResult.error) ? 'oauth 429' : 'oauth error';
      output.appendLine(`[info:claude] ${reason}, using cached result`);
      return { ...lastClaudeRateLimitResult, sourceLabel: `${lastClaudeRateLimitResult.sourceLabel} (cached)` };
    }

    // API 완전 실패 + 캐시 없음
    if (isClaudeRateLimitError(oauthResult?.error)) {
      const remainSec = lastClaudeOauth429At
        ? Math.max(0, Math.ceil((lastClaudeOauth429RetryAfterMs - (Date.now() - lastClaudeOauth429At)) / 1000))
        : 0;
      output.appendLine(`[info:claude] rate limited, no local data or cache (cooldown ${remainSec}s remaining)`);
      return { ok: false, error: `Rate limited by Claude API (retry in ${remainSec}s)` };
    }

    if (shouldAssumeClaudeFullFromNoData(oauthResult?.error, projectsRoot)) {
      output.appendLine('[info:claude] no session data anywhere, assuming full quota');
      return buildClaudeAssumedFullResult('no data available');
    }

    return { ok: false, error: oauthResult?.error || 'No Claude data available' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchClaudeUsageFromOauth(output) {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(credPath)) {
      return { ok: false, error: `Missing ${credPath}` };
    }

    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const token = cred?.claudeAiOauth?.accessToken;
    if (!token) {
      return { ok: false, error: 'No Claude OAuth access token in credentials' };
    }

    // Check token expiry before making the request
    const expiresAt = cred?.claudeAiOauth?.expiresAt;
    if (expiresAt) {
      // expiresAt can be epoch-ms or epoch-s; normalize to ms
      const expiresMs = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
      if (Date.now() >= expiresMs - 60000) {
        output.appendLine('[warn:claude] OAuth token expired or expiring — run: claude to re-login');
        return { ok: false, error: 'OAuth token expired (run: claude to re-login)' };
      }
    }

    output.appendLine('[run:claude-oauth] GET /api/oauth/usage');
    const data = await httpsGetJson('api.anthropic.com', '/api/oauth/usage', {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    }, CLAUDE_OAUTH_TIMEOUT_MS);

    const rateLimits = {
      primary: {
        used_percent: normalizeUtilizationToUsedPercent(data?.five_hour?.utilization),
        resets_at: isoToEpochSeconds(data?.five_hour?.resets_at),
      },
      secondary: {
        used_percent: normalizeUtilizationToUsedPercent(data?.seven_day?.utilization),
        resets_at: isoToEpochSeconds(data?.seven_day?.resets_at),
      },
    };

    // If both windows returned no utilization data, treat it as no-data (idle/new session) and assume full.
    if (rateLimits.primary.used_percent === null && rateLimits.secondary.used_percent === null) {
      output.appendLine('[info:claude] oauth returned no utilization data, assuming full quota');
      return buildClaudeAssumedFullResult('Claude OAuth API (no utilization data)');
    }

    const summary = formatRateLimitSingleWindowSummary(rateLimits);
    const raw = `Claude H/W left\n${formatRateLimitRaw(rateLimits)}`;
    return {
      ok: true,
      summary,
      raw,
      sourceLabel: 'Source: Claude OAuth API',
      rateLimits,
      groups: [{ label: 'Claude', rateLimits }],
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchCopilotUsage(output) {
  let auto = null;
  for (let attempt = 1; attempt <= PROVIDER_MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      auto = await fetchCopilotUsageFromGithub(output);
      if (auto.ok) {
        return auto;
      }
      output.appendLine(`[info:copilot] auto failed (attempt ${attempt}/${PROVIDER_MAX_RETRY_ATTEMPTS}): ${auto.error}`);
    } catch (_err) {
      const message = _err instanceof Error ? _err.message : String(_err);
      auto = { ok: false, error: message };
      output.appendLine(`[warn:copilot] unexpected error in GitHub auth (attempt ${attempt}/${PROVIDER_MAX_RETRY_ATTEMPTS}): ${message}`);
    }
    if (!isCopilotRetriableError(auto?.error) || attempt >= PROVIDER_MAX_RETRY_ATTEMPTS) {
      break;
    }
    await sleep(RETRY_DELAY_MS * attempt);
  }

  output.appendLine(`[info:copilot] fallback to command: ${auto?.error || 'unknown auto error'}`);
  return fetchSimpleCommandUsage(
    'copilotUsage.command',
    'copilotUsage.commandTimeoutMs',
    output,
    'copilot'
  );
}

async function fetchCopilotUsageFromGithub(output) {
  try {
    if (!vscode.authentication || !vscode.authentication.getSession) {
      return { ok: false, error: 'VS Code authentication API unavailable' };
    }

    // 1) Try silent lookup first to avoid unnecessary prompts on periodic refresh.
    let session = await vscode.authentication.getSession(
      'github',
      ['read:user', 'user:email'],
      { silent: true }
    );

    // 2) If there is no session, request sign-in once per VS Code session.
    if (!session?.accessToken && !copilotAuthPromptAttempted) {
      copilotAuthPromptAttempted = true;
      output.appendLine('[info:copilot] no GitHub auth session, requesting sign-in');
      try {
        session = await vscode.authentication.getSession(
          'github',
          ['read:user', 'user:email'],
          { createIfNone: true }
        );
      } catch (authErr) {
        output.appendLine(`[info:copilot] sign-in prompt dismissed or failed: ${authErr instanceof Error ? authErr.message : String(authErr)}`);
      }
    }

    if (!session?.accessToken) {
      return { ok: false, error: 'No GitHub auth session (sign in via Accounts -> GitHub)' };
    }

    output.appendLine('[run:copilot-api] GET /copilot_internal/user');
    const data = await httpsGetJson('api.github.com', '/copilot_internal/user', {
      Authorization: `Bearer ${session.accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'AI-Usage-Status-Bar',
    }, 8000);
    const snapshots = data?.quota_snapshots ? Object.values(data.quota_snapshots) : [];
    const premium = snapshots.find((q) => q?.quota_id === 'premium_interactions') || snapshots[0];
    if (!premium) {
      const plan = data?.copilot_plan || data?.access_type_sku || 'unknown';
      return {
        ok: true,
        summary: String(plan),
        raw: `Copilot plan: ${plan}`,
        sourceLabel: 'Source: GitHub Copilot API',
      };
    }

    if (premium.unlimited) {
      const resetRaw = data?.quota_reset_date_utc || data?.quota_reset_date;
      const resetEpoch = isoToEpochSeconds(resetRaw);
      const resetText = formatTimeRemainingShort(resetEpoch);
      return {
        ok: true,
        summary: `M∞ ${resetText}`,
        raw: `Copilot unlimited quota${resetRaw ? `, reset ${formatReset(resetEpoch)}` : ''}`,
        sourceLabel: 'Source: GitHub Copilot API',
        quota: {
          leftPercent: 100,
          resetsAt: resetEpoch,
          window: 'monthly',
        },
      };
    }

    if (typeof premium.entitlement !== 'number') {
      return { ok: false, error: 'Copilot quota entitlement missing' };
    }

    const remaining = Number(premium.remaining);
    const entitlement = Number(premium.entitlement);
    const usedPercent = entitlement > 0 ? ((entitlement - remaining) / entitlement) * 100 : null;
    const resetEpoch = isoToEpochSeconds(data?.quota_reset_date_utc || data?.quota_reset_date);
    const leftPercent = toLeftPercent(usedPercent);
    const summary = `M${leftPercent !== null ? `${leftPercent}%` : 'Full'} ${formatTimeRemainingShort(resetEpoch)}`;
    const raw = `Copilot monthly left ${leftPercent !== null ? `${leftPercent}%` : 'Full'} for ${formatTimeRemainingLong(resetEpoch)} (reset ${formatReset(resetEpoch)})`;
    return {
      ok: true,
      summary,
      raw,
      sourceLabel: 'Source: GitHub Copilot API',
      quota: {
        leftPercent,
        resetsAt: resetEpoch,
        window: 'monthly',
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchGeminiUsage(output) {
  try {
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      return {
        ok: true,
        summary: 'API key mode',
        raw: 'Gemini API key mode (quota details unavailable)',
        sourceLabel: 'Source: Gemini API key mode',
        geminiModels: [],
      };
    }

    const credPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
    if (!fs.existsSync(credPath)) {
      return { ok: false, error: `Missing ${credPath}` };
    }

    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    let accessToken = creds?.access_token;
    const refreshToken = creds?.refresh_token;
    const expiryMs = normalizeGeminiExpiryMs(creds?.expiry_date);

    if (!accessToken) {
      return { ok: false, error: 'No Gemini OAuth access token' };
    }

    const isLikelyExpired = (typeof expiryMs === 'number') && Date.now() >= (expiryMs - 60000);
    output.appendLine(`[gemini:auth] expiryMs=${expiryMs ?? 'n/a'} expired=${isLikelyExpired}`);

    // Do not fail early on refresh failure.
    // Prefer using current access token first; refresh only on actual auth failure.
    if (isLikelyExpired && refreshToken) {
      const refreshed = await refreshGeminiAccessToken(creds, output);
      if (refreshed) {
        accessToken = refreshed;
        output.appendLine('[gemini:auth] proactive refresh succeeded');
      } else {
        output.appendLine('[gemini:auth] proactive refresh failed, trying existing access token');
      }
    }

    const executeWithRetry = async () => {
      try {
        const projectId = await fetchGeminiProjectId(accessToken);
        if (!projectId) {
          return { ok: false, error: 'Gemini project id unavailable' };
        }
        return await fetchGeminiQuotaBuckets(accessToken, projectId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isGeminiAuthError(message) || !refreshToken) {
          throw err;
        }
        output.appendLine(`[gemini:auth] API auth failed (${message}), trying refresh`);
        const refreshed = await refreshGeminiAccessToken(creds, output);
        if (!refreshed) {
          throw new Error('Gemini OAuth token refresh failed after auth error');
        }
        accessToken = refreshed;
        output.appendLine('[gemini:auth] refresh after auth error succeeded');
        const retryProjectId = await fetchGeminiProjectId(accessToken);
        if (!retryProjectId) {
          throw new Error('Gemini project id unavailable after token refresh');
        }
        return await fetchGeminiQuotaBuckets(accessToken, retryProjectId);
      }
    };

    output.appendLine('[run:gemini-oauth] POST loadCodeAssist + retrieveUserQuota');
    const buckets = await executeWithRetry();
    const models = buildGeminiModelsFromBuckets(buckets);
    const summary = formatGeminiStatusSummary(models);
    const raw = models.length > 0
      ? models.map((m) => `${m.shortLabel} left ${m.leftPercent}% (reset ${formatReset(m.resetsAt)})`).join(' | ')
      : 'No Gemini quota buckets';

    return {
      ok: true,
      summary,
      raw,
      sourceLabel: 'Source: Gemini Code Assist API',
      geminiModels: models,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function refreshGeminiAccessToken(creds, output) {
  try {
    if (!creds?.refresh_token) {
      return null;
    }

    const candidates = getGeminiRefreshClientCandidates(creds, output);
    for (const candidate of candidates) {
      try {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: creds?.refresh_token || '',
          client_id: candidate.clientId,
          client_secret: candidate.clientSecret,
        }).toString();

        const data = await httpsRequestJson(
          'oauth2.googleapis.com',
          '/token',
          'POST',
          { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          GEMINI_TIMEOUT_MS
        );

        const newToken = data?.access_token;
        if (!newToken) {
          continue;
        }
        const updated = {
          ...creds,
          client_id: candidate.clientId,
          client_secret: candidate.clientSecret,
          access_token: newToken,
          expiry_date: Date.now() + Number(data?.expires_in || 3600) * 1000,
        };
        const credPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
        fs.writeFileSync(credPath, JSON.stringify(updated, null, 2), 'utf8');
        output?.appendLine(`[gemini:auth] refresh succeeded source=${candidate.source} clientId=*${maskTail(candidate.clientId, 8)}`);
        return newToken;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output?.appendLine(`[gemini:auth] refresh failed source=${candidate.source} clientId=*${maskTail(candidate.clientId, 8)}: ${truncateMessage(msg, 180)}`);
      }
    }
    output?.appendLine('[gemini:auth] all refresh client candidates exhausted');
    return null;
  } catch (_err) {
    return null;
  }
}

function getGeminiRefreshClientCandidates(creds, output) {
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (clientId, clientSecret, source) => {
    if (!clientId || !clientSecret) return;
    const key = `${clientId}::${clientSecret}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ clientId, clientSecret, source });
  };

  pushCandidate(creds?.client_id, creds?.client_secret, 'creds');

  for (const c of readGeminiCliOauthClientCandidates(output)) {
    pushCandidate(c.clientId, c.clientSecret, c.source);
  }

  pushCandidate(GEMINI_CLIENT_ID, GEMINI_CLIENT_SECRET, 'default');
  pushCandidate(GEMINI_LEGACY_CLIENT_ID, GEMINI_CLIENT_SECRET, 'legacy-client-id');
  pushCandidate(GEMINI_LEGACY_CLIENT_ID, GEMINI_LEGACY_CLIENT_SECRET, 'legacy');

  output?.appendLine(`[gemini:auth] refresh client candidates=${candidates.map((c) => `${c.source}:*${maskTail(c.clientId, 8)}`).join(', ')}`);
  return candidates;
}

function readGeminiCliOauthClientCandidates(output) {
  const candidates = [];
  const candidatePaths = [];
  const appData = process.env.APPDATA;
  if (appData) {
    candidatePaths.push(
      path.join(
        appData,
        'npm',
        'node_modules',
        '@google',
        'gemini-cli',
        'node_modules',
        '@google',
        'gemini-cli-core',
        'dist',
        'src',
        'code_assist',
        'oauth2.js'
      )
    );
  }
  if (process.env.GEMINI_CLI_CORE_OAUTH_FILE) {
    candidatePaths.push(process.env.GEMINI_CLI_CORE_OAUTH_FILE);
  }

  for (const p of candidatePaths) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      const idMatch = text.match(/OAUTH_CLIENT_ID\s*=\s*'([^']+)'/);
      const secretMatch = text.match(/OAUTH_CLIENT_SECRET\s*=\s*'([^']+)'/);
      if (idMatch?.[1] && secretMatch?.[1]) {
        candidates.push({
          clientId: idMatch[1],
          clientSecret: secretMatch[1],
          source: 'gemini-cli-core',
        });
        output?.appendLine(`[gemini:auth] discovered oauth client from ${p}`);
        break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output?.appendLine(`[gemini:auth] failed to read oauth client file ${p}: ${truncateMessage(msg, 160)}`);
    }
  }

  return candidates;
}

function maskTail(value, tailLen) {
  const s = String(value || '');
  if (!s) return '';
  return s.slice(-Math.max(1, tailLen || 4));
}

function truncateMessage(message, maxLen) {
  const s = String(message || '');
  if (!maxLen || s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 3))}...`;
}

function normalizeGeminiExpiryMs(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return null;
  }
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  // Some environments store expiry in epoch-seconds.
  return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
}

async function fetchGeminiProjectId(accessToken) {
  const data = await httpsRequestJson(
    'cloudcode-pa.googleapis.com',
    GEMINI_CODE_ASSIST_ENDPOINT,
    'POST',
    {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    JSON.stringify({
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    }),
    GEMINI_TIMEOUT_MS
  );
  return data?.cloudaicompanionProject || null;
}

async function fetchGeminiQuotaBuckets(accessToken, projectId) {
  const data = await httpsRequestJson(
    'cloudcode-pa.googleapis.com',
    GEMINI_QUOTA_ENDPOINT,
    'POST',
    {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    JSON.stringify({ project: projectId }),
    GEMINI_TIMEOUT_MS
  );
  return Array.isArray(data?.buckets) ? data.buckets : [];
}

function isGeminiAuthError(message) {
  const msg = String(message || '').toLowerCase();
  return msg.includes('http 401') || msg.includes('http 403') || msg.includes('authentication');
}

function buildGeminiModelsFromBuckets(buckets) {
  const categories = [
    {
      id: 'pro',
      shortLabel: 'P',
      label: 'Pro',
      ids: ['gemini-2.5-pro', 'gemini-3.1-pro-preview'],
    },
    {
      id: 'flash',
      shortLabel: 'F',
      label: 'Flash',
      ids: ['gemini-2.5-flash', 'gemini-3-flash-preview'],
    },
    {
      id: 'flash-lite',
      shortLabel: 'FL',
      label: 'Flash Lite',
      ids: ['gemini-2.5-flash-lite'],
    },
  ];

  const results = [];
  for (const category of categories) {
    const matched = buckets.filter((b) => category.ids.includes(String(b?.modelId || '')));
    if (matched.length === 0) {
      results.push({
        id: category.id,
        shortLabel: category.shortLabel,
        label: category.label,
        leftPercent: null,
        resetsAt: null,
      });
      continue;
    }

    const candidates = matched.map((b) => {
      const left = typeof b?.remainingFraction === 'number'
        ? Math.max(0, Math.min(100, Math.round(b.remainingFraction * 1000) / 10))
        : null;
      return {
        leftPercent: left,
        resetsAt: isoToEpochSeconds(b?.resetTime),
      };
    }).filter((v) => v.leftPercent !== null);

    if (candidates.length === 0) {
      results.push({
        id: category.id,
        shortLabel: category.shortLabel,
        label: category.label,
        leftPercent: null,
        resetsAt: null,
      });
      continue;
    }

    candidates.sort((a, b) => a.leftPercent - b.leftPercent);
    results.push({
      id: category.id,
      shortLabel: category.shortLabel,
      label: category.label,
      leftPercent: candidates[0].leftPercent,
      resetsAt: candidates[0].resetsAt,
    });
  }

  return results;
}

function formatGeminiStatusSummary(models) {
  const filtered = getGeminiModelsForStatusbar(models);
  if (filtered.length === 0) {
    return getI18n(getConfig().language).noData;
  }
  return filtered.map((m) => `${m.shortLabel}:${m.leftPercent !== null ? `${m.leftPercent}%` : 'Full'} ${formatTimeRemainingShort(m.resetsAt)}`).join(' | ');
}

async function fetchSimpleCommandUsage(commandKey, timeoutKey, output, label) {
  const config = vscode.workspace.getConfiguration();
  const command = config.get(commandKey, '').trim();
  const timeoutMs = config.get(timeoutKey, 8000);
  if (!command) {
    return { ok: false, error: `Set ${commandKey} first` };
  }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  output.appendLine(`[run:${label}] ${command}`);

  return new Promise((resolve) => {
    exec(
      command,
      { timeout: timeoutMs, cwd },
      (error, stdout, stderr) => {
        if (error) {
          return resolve({ ok: false, error: stderr?.trim() || error.message });
        }
        const raw = (stdout || '').trim();
        if (!raw) {
          return resolve({ ok: false, error: 'Empty command output' });
        }
        return resolve({ ok: true, summary: parseUsageSummary(raw), raw: truncate(raw, 400), sourceLabel: `Source: command (${label})` });
      }
    );
  });
}

function fetchUsageFromCommand(cfg, output) {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  output.appendLine(`[run:command] ${cfg.command}`);

  return new Promise((resolve) => {
    exec(
      cfg.command,
      {
        timeout: cfg.commandTimeoutMs,
        cwd,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() || error.message;
          return resolve({ ok: false, error: detail });
        }

        const raw = (stdout || '').trim();
        if (!raw) {
          return resolve({ ok: false, error: 'Empty output from usage command' });
        }

        output.appendLine(`[ok:command] ${truncate(raw, 240)}`);
        const summary = parseUsageSummary(raw);
        resolve({ ok: true, summary, raw: truncate(raw, 400), sourceLabel: 'Source: command' });
      }
    );
  });
}

async function fetchUsageFromSessionLog(cfg, output) {
  try {
    const sessionsRoot = expandHome(cfg.sessionsRoot);
    const newest = findNewestFileRecursive(sessionsRoot);
    if (!newest) {
      return { ok: false, error: `No session files found in ${sessionsRoot}` };
    }

    output.appendLine(`[run:session] ${newest}`);
    const groupsByLimit = readLatestTokenCountByLimit(newest);
    const limitIds = Object.keys(groupsByLimit);
    if (limitIds.length === 0) {
      return { ok: false, error: `No token_count event found in ${newest}` };
    }

    const orderedLimitIds = orderLimitIds(limitIds);
    const summary = orderedLimitIds
      .map((id) => formatRateLimitGroupCompact(groupsByLimit[id].rate_limits))
      .join(' / ');
    const raw = orderedLimitIds
      .map((id) => formatRateLimitGroupRaw(groupsByLimit[id].rate_limits))
      .join('\n');
    const groups = orderedLimitIds.map((id) => ({
      label: mapLimitLabel(groupsByLimit[id].rate_limits),
      rateLimits: groupsByLimit[id].rate_limits,
    }));
    return { ok: true, summary, raw, sourceLabel: 'Source: session log', groups };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseUsageSummary(raw) {
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const firstLine = lines[0] || raw;

  try {
    const parsed = JSON.parse(raw);
    const used = firstDefined(parsed, ['used', 'usage', 'current']);
    const limit = firstDefined(parsed, ['limit', 'quota', 'max']);
    const pct = firstDefined(parsed, ['percent', 'percentage']);
    const reset = firstDefined(parsed, ['reset', 'resetsAt', 'periodEnd']);

    if (used !== undefined && limit !== undefined) {
      const pctText = pct !== undefined ? ` (${pct}%)` : '';
      return `${used}/${limit}${pctText}${reset ? `, reset ${reset}` : ''}`;
    }

    if (pct !== undefined) {
      return `${pct}%${reset ? `, reset ${reset}` : ''}`;
    }
  } catch (_err) {
    // Ignore parse errors and use text fallback.
  }

  const percentMatch = raw.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  const usageMatch = raw.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);

  if (usageMatch) {
    const used = usageMatch[1];
    const limit = usageMatch[2];
    const pctText = percentMatch ? ` (${percentMatch[1]}%)` : '';
    return `${used}/${limit}${pctText}`;
  }

  if (percentMatch) {
    return `${percentMatch[1]}%`;
  }

  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined && obj[key] !== null) {
      return obj[key];
    }
  }
  return undefined;
}

function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function findNewestFileRecursive(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return null;
  }

  let newestPath = null;
  let newestMtime = 0;

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !full.endsWith('.jsonl')) {
        continue;
      }

      const stat = fs.statSync(full);
      if (stat.mtimeMs > newestMtime) {
        newestMtime = stat.mtimeMs;
        newestPath = full;
      }
    }
  }

  return newestPath;
}

function readLatestTokenCountByLimit(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const byLimit = {};

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    try {
      const obj = JSON.parse(line);
      const payload = obj?.payload;
      if (obj?.type !== 'event_msg') {
        continue;
      }
      if (payload?.type !== 'token_count') {
        continue;
      }
      const rateLimits = payload?.rate_limits;
      if (!rateLimits) {
        continue;
      }
      const limitId = rateLimits?.limit_id || 'unknown';
      if (!byLimit[limitId]) {
        byLimit[limitId] = payload;
      }
    } catch (_err) {
      // Continue scanning older lines on parse failure.
    }
  }

  return byLimit;
}

/**
 * 로컬 JSONL 파일에서 현재 5시간 세션의 토큰 사용량을 읽어 rateLimits 객체를 생성.
 * API 429 오류 시 fallback으로 사용.
 */
function buildClaudeRateLimitsFromLocalTokenCount(projectsRoot, credPath, output) {
  try {
    // 플랜 한도 결정 (credentials.json의 subscriptionType 참고)
    let planLimit = 44000; // 기본 pro
    try {
      if (fs.existsSync(credPath)) {
        const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        const subType = (cred?.claudeAiOauth?.subscriptionType || '').toLowerCase();
        planLimit = CLAUDE_PLAN_TOKEN_LIMITS[subType] || 44000;
      }
    } catch (_e) { /* ignore */ }

    if (!fs.existsSync(projectsRoot)) {
      return null;
    }

    // 모든 JSONL 파일 수집
    const files = [];
    const stack = [projectsRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_e) { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (entry.isFile() && full.endsWith('.jsonl')) { files.push(full); }
      }
    }

    // 각 파일에서 최근 5시간 내 assistant 메시지의 토큰 수집 (UUID 기반 dedup)
    const now = Date.now();
    const windowStart = now - CLAUDE_SESSION_WINDOW_MS;
    const seenUuids = new Set();
    const messages = [];

    for (const filePath of files) {
      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch (_e) { continue; }
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.type !== 'assistant') continue;
          const msgId = obj?.uuid || obj?.message?.id || null;
          if (msgId && seenUuids.has(msgId)) continue;
          if (msgId) seenUuids.add(msgId);
          const ts = obj?.timestamp ? new Date(obj.timestamp).getTime() : 0;
          if (!ts || ts < windowStart) continue;
          const usage = obj?.message?.usage;
          if (!usage) continue;
          const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
          if (tokens > 0) messages.push({ ts, tokens });
        } catch (_e) { /* ignore */ }
      }
    }

    if (messages.length === 0) return null;

    // 가장 오래된 메시지 기준으로 5시간 윈도우 세션 시작 계산
    messages.sort((a, b) => a.ts - b.ts);
    const sessionStart = messages[0].ts;
    const sessionEnd = sessionStart + CLAUDE_SESSION_WINDOW_MS;
    const usedTokens = messages.reduce((s, m) => s + m.tokens, 0);
    const usedPercent = Math.min((usedTokens / planLimit) * 100, 100);
    const resetsAtSec = Math.floor(sessionEnd / 1000);

    const rateLimits = {
      primary: { used_percent: usedPercent, resets_at: resetsAtSec },
      secondary: null,
    };
    const summary = formatRateLimitSingleWindowSummary(rateLimits);
    const raw = `Claude session tokens: ${usedTokens.toLocaleString()} / ${planLimit.toLocaleString()}`;
    const result = {
      ok: true,
      summary,
      raw,
      sourceLabel: `Source: local JSONL token count (${usedTokens.toLocaleString()}/${planLimit.toLocaleString()} tokens)`,
      rateLimits,
      groups: [{ label: 'Claude', rateLimits }],
    };
    return { result, usedTokens, planLimit };
  } catch (err) {
    if (output) output.appendLine(`[warn:claude] local token count failed: ${err.message}`);
    return null;
  }
}

function readLatestClaudeRateLimitsFromSession(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);

      // Check various possible locations for rate_limits with five_hour/seven_day
      const candidates = [
        obj?.rate_limits,
        obj?.message?.rate_limits,
        obj?.data?.rate_limits,
        obj?.data?.message?.rate_limits,
        obj?.payload?.rate_limits,
      ];

      for (const rl of candidates) {
        if (rl && (rl.five_hour || rl.seven_day)) {
          return {
            primary: {
              used_percent: normalizeUtilizationToUsedPercent(rl.five_hour?.utilization),
              resets_at: isoToEpochSeconds(rl.five_hour?.resets_at),
            },
            secondary: {
              used_percent: normalizeUtilizationToUsedPercent(rl.seven_day?.utilization),
              resets_at: isoToEpochSeconds(rl.seven_day?.resets_at),
            },
          };
        }
      }
    } catch (_err) {
      // ignore malformed lines
    }
  }
  return null;
}

function readLatestClaudeUsage(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    try {
      const obj = JSON.parse(line);
      const direct = obj?.message?.usage;
      if (direct && typeof direct === 'object') {
        return direct;
      }
      const nested = obj?.data?.message?.message?.usage;
      if (nested && typeof nested === 'object') {
        return nested;
      }
    } catch (_err) {
      // ignore malformed lines
    }
  }
  return null;
}

function orderLimitIds(limitIds) {
  return [...limitIds].sort((a, b) => {
    if (a === 'codex') {
      return -1;
    }
    if (b === 'codex') {
      return 1;
    }
    return a.localeCompare(b);
  });
}

function getI18n(language) {
  return I18N[language] || I18N.ko;
}

function buildStatusBarTextEn(result) {
  return rebuildStatusBarText(result, STATUS_BAR_LANGUAGE);
}

function formatRateLimitGroupCompact(rateLimits, language) {
  const usage = formatRateLimitSingleWindowSummary(rateLimits, language);
  const label = mapLimitLabel(rateLimits, language);
  if (label === 'Spark') {
    return `Spark ${usage}`;
  }
  return usage;
}

function formatRateLimitSingleWindowSummary(rateLimits, language) {
  const primaryUsed = rateLimits?.primary?.used_percent;
  const secondaryUsed = rateLimits?.secondary?.used_percent;
  const primaryLeftPct = toLeftPercent(primaryUsed);
  const secondaryLeftPct = toLeftPercent(secondaryUsed);
  const primaryLeft = formatTimeRemainingShort(rateLimits?.primary?.resets_at, language);
  const secondaryLeft = formatTimeRemainingShort(rateLimits?.secondary?.resets_at, language);
  const hasPrimaryWindow = !!rateLimits?.primary;
  const hasSecondaryWindow = !!rateLimits?.secondary;

  const hasPrimaryData = primaryLeftPct !== null;
  // W is only shown alongside H when weekly usage is critically low (< 5%)
  const showWeeklyAlongsideHourly = (
    hasPrimaryData &&
    secondaryLeftPct !== null &&
    secondaryLeftPct < WEEKLY_LOW_PERCENT_THRESHOLD
  );
  // Always show H when we have primary data — including H=0% (show reset countdown)
  if (hasPrimaryData) {
    if (showWeeklyAlongsideHourly) {
      return `H${primaryLeftPct}% ${primaryLeft} W${secondaryLeftPct}% ${secondaryLeft}`;
    }
    return `H${primaryLeftPct}% ${primaryLeft}`;
  }

  if (secondaryLeftPct !== null) {
    return `W${secondaryLeftPct}% ${secondaryLeft}`;
  }
  if (hasPrimaryWindow) {
    return `HFull ${primaryLeft}`;
  }
  if (hasSecondaryWindow) {
    return `WFull ${secondaryLeft}`;
  }

  return getI18n(language || getConfig().language).noPercentData;
}

function findNewestClaudeSessionWithRateLimits(rootDir, maxCandidates = 20) {
  if (!fs.existsSync(rootDir)) {
    return null;
  }

  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !full.endsWith('.jsonl')) {
        continue;
      }
      const stat = fs.statSync(full);
      files.push({ filePath: full, mtimeMs: stat.mtimeMs });
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limit = Math.max(1, maxCandidates);
  for (let i = 0; i < Math.min(files.length, limit); i += 1) {
    const item = files[i];
    const rateLimits = readLatestClaudeRateLimitsFromSession(item.filePath);
    if (rateLimits) {
      return { filePath: item.filePath, rateLimits };
    }
  }
  return null;
}

function buildClaudeAssumedFullResult(reason) {
  const rateLimits = {
    primary: { used_percent: 0, resets_at: null },
    secondary: { used_percent: 0, resets_at: null },
  };
  const summary = formatRateLimitSingleWindowSummary(rateLimits);
  const raw = `Claude H/W left\n${formatRateLimitRaw(rateLimits)}`;
  return {
    ok: true,
    summary,
    raw,
    sourceLabel: `Source: ${reason} (assumed full)`,
    rateLimits,
    groups: [{ label: 'Claude', rateLimits }],
  };
}

function getGeminiToggleValue(config, key, fallback) {
  const fallbackValue = getGeminiToggleFallback(key, fallback);
  try {
    const inspected = config.inspect(key);
    if (inspected === undefined) {
      return fallbackValue;
    }
    const explicit =
      inspected.workspaceFolderValue ??
      inspected.workspaceValue ??
      inspected.globalValue;
    if (typeof explicit === 'boolean') {
      return explicit;
    }
    if (typeof fallbackValue === 'boolean') {
      return fallbackValue;
    }
    if (typeof inspected.defaultValue === 'boolean') {
      return inspected.defaultValue;
    }
    return config.get(key, fallback);
  } catch (_err) {
    // fallback to global state
    return fallbackValue;
  }
}

function getGeminiToggleFallback(key, fallback) {
  if (!extensionState) return fallback;
  const v = extensionState.get(`fallback.${key}`);
  return typeof v === 'boolean' ? v : fallback;
}

function shouldAssumeClaudeFullFromNoData(oauthError, projectsRoot) {
  const msg = String(oauthError || '').toLowerCase();
  if (msg.includes('no utilization data')) {
    return true;
  }
  // Soft no-data case: Claude local directory exists but session rate-limit data is not available yet.
  if (projectsRoot && fs.existsSync(projectsRoot)) {
    return true;
  }
  // Hard failures (installation/auth missing) should remain unavailable.
  return false;
}

function isClaudeRateLimitError(err) {
  const msg = String(err || '').toLowerCase();
  return msg.includes('http 429') || msg.includes('rate_limit_error') || msg.includes('rate limit cooldown');
}

function isClaudeTransientError(err) {
  const msg = String(err || '').toLowerCase();
  return (
    msg.includes('request timed out') ||
    msg.includes('http 500') ||
    msg.includes('internal server error') ||
    msg.includes('econnreset') ||
    msg.includes('network')
  );
}

function isCopilotRetriableError(err) {
  const msg = String(err || '').toLowerCase();
  return (
    msg.includes('canceled') ||
    msg.includes('timed out') ||
    msg.includes('http 500') ||
    msg.includes('internal server error') ||
    msg.includes('econnreset') ||
    msg.includes('network') ||
    msg.includes('no github auth session')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryCopilotOnStartup(result) {
  if (!result || result.ok) return false;
  const msg = String(result.error || '').toLowerCase();
  return (
    msg.includes('no github auth session') ||
    msg.includes('authentication api unavailable') ||
    msg.includes('timed out') ||
    msg.includes('network') ||
    msg.includes('econnreset')
  );
}

function getGeminiModelsForStatusbar(models) {
  const cfg = getConfig();
  const list = Array.isArray(models) ? models : [];
  return list.filter((m) => {
    if (m.id === 'flash-lite') return cfg.geminiShowFlashLite;
    if (m.id === 'flash') return cfg.geminiShowFlash;
    if (m.id === 'pro') return cfg.geminiShowPro;
    return true;
  });
}

function rebuildStatusBarText(result, language) {
  if (!result || !result.ok) return '-';
  if (result.quota) {
    const { leftPercent, resetsAt, unlimited } = result.quota;
    const resetText = formatTimeRemainingShort(resetsAt, language);
    if (unlimited) return `M∞ ${resetText}`;
    return `M${leftPercent !== null ? `${leftPercent}%` : 'Full'} ${resetText}`;
  }
  if (Array.isArray(result.geminiModels)) {
    const filtered = getGeminiModelsForStatusbar(result.geminiModels);
    if (filtered.length === 0) {
      return getI18n(language || getConfig().language).noData;
    }
    return filtered
      .map((m) => `${m.shortLabel}:${m.leftPercent !== null ? `${m.leftPercent}%` : 'Full'} ${formatTimeRemainingShort(m.resetsAt, language)}`)
      .join(' | ');
  }
  if (result.groups && result.groups.length > 0) {
    return result.groups.map((g) => formatRateLimitGroupCompact(g.rateLimits, language)).join(' / ');
  }
  if (result.rateLimits) {
    return formatRateLimitSingleWindowSummary(result.rateLimits, language);
  }
  return result.summary || '-';
}

function formatRateLimitGroupRaw(rateLimits) {
  const label = mapLimitLabel(rateLimits);
  return `${label}: ${formatRateLimitRaw(rateLimits)}`;
}

function formatRateLimitRaw(rateLimits) {
  const parts = [];

  if (rateLimits?.primary) {
    const leftPct = toLeftPercent(rateLimits.primary.used_percent);
    parts.push(
      `H left ${leftPct !== null ? `${leftPct}%` : 'Full'} for ${formatTimeRemainingLong(rateLimits.primary.resets_at)} (reset ${formatReset(rateLimits.primary.resets_at)})`
    );
  }
  if (rateLimits?.secondary) {
    const leftPct = toLeftPercent(rateLimits.secondary.used_percent);
    parts.push(
      `W left ${leftPct !== null ? `${leftPct}%` : 'Full'} for ${formatTimeRemainingLong(rateLimits.secondary.resets_at)} (reset ${formatReset(rateLimits.secondary.resets_at)})`
    );
  }

  return parts.join(' | ') || 'No rate limit details';
}

function mapLimitLabel(rateLimits, language) {
  const id = rateLimits?.limit_id;
  const name = rateLimits?.limit_name;

  if (id === 'codex') {
    return 'Core';
  }
  if (id && id.toLowerCase().includes('bengalfox')) {
    return 'Spark';
  }
  if (name && String(name).toLowerCase().includes('spark')) {
    return 'Spark';
  }
  return name || id || getI18n(language || getConfig().language).unknown;
}

function formatReset(epochSeconds) {
  if (typeof epochSeconds !== 'number') {
    return '-';
  }
  const d = new Date(epochSeconds * 1000);
  return d.toLocaleString();
}

function formatTimeRemainingShort(epochSeconds, language) {
  const info = getRemainingParts(epochSeconds);
  if (!info.valid) {
    return '-';
  }
  const u = getI18n(language || getConfig().language);
  if (info.days > 0) {
    return `${info.days}${u.dUnit} ${info.hours}${u.hUnit}`;
  }
  return `${info.hours}${u.hUnit} ${info.minutes}${u.mUnit}`;
}

function formatTimeRemainingLong(epochSeconds, language) {
  const info = getRemainingParts(epochSeconds);
  if (!info.valid) {
    const u = getI18n(language || getConfig().language);
    return info.expired ? (u.resets || '-') : '-';
  }
  const u = getI18n(language || getConfig().language);
  return `${info.days}${u.dUnit} ${info.hours}${u.hUnit} ${info.minutes}${u.mUnit}`;
}

function getRemainingParts(epochSeconds) {
  if (typeof epochSeconds !== 'number') {
    return { valid: false };
  }

  const diffMs = epochSeconds * 1000 - Date.now();
  if (diffMs <= 0) {
    // resets_at is in the past — window already expired
    return { valid: false, expired: true };
  }

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  return {
    valid: true,
    totalMinutes,
    days,
    hours,
    minutes,
  };
}

function getQuotaEmoji(leftPercent) {
  if (leftPercent === null || leftPercent === undefined) return '❓';
  if (leftPercent > 50) return '🟢';
  if (leftPercent > 20) return '🟡';
  if (leftPercent > 5) return '🟠';
  return '🔴';
}

// 툴팁 테이블: 각 윈도우를 Left%와 Reset 두 컬럼으로 분리하여 가독성 향상
function buildProviderTooltip(providerName, icon, result) {
  const t = I18N[getConfig().language] || I18N.ko;
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = false;
  md.supportHtml = true;

  md.appendMarkdown(`## ${icon} ${providerName}\n\n`);

  if (!result?.ok) {
    md.appendMarkdown(`> ⚠️ _${t.unavailable}_\n\n`);
    md.appendMarkdown('---\n\n');
    md.appendMarkdown(`_$(sync) ${t.clickToRefresh}_`);
    return md;
  }

  // 스타일 상수
  const tbl  = 'style="border-collapse:collapse;margin:4px 0"';
  const hCell = (extra = '') => `style="padding:4px 14px;text-align:center;border-bottom:1px solid #606060;${extra}"`;
  const subH  = (align = 'center') => `style="padding:2px 14px;text-align:${align};font-weight:normal;color:#999;font-size:0.9em"`;
  const cell  = (align = 'center') => `style="padding:5px 14px;text-align:${align}"`;
  const emojiCell = 'style="padding:5px 8px;text-align:center"';
  const sep   = '<td style="width:6px"></td>';
  const sepH  = '<td style="width:6px;border-bottom:1px solid #606060"></td>';

  if (providerName === 'Copilot' && result.quota) {
    const leftPct = result.quota.leftPercent;
    const emoji   = getQuotaEmoji(leftPct);
    const pctText = leftPct == null ? '<b>Full</b>' : `<b>${leftPct}%</b>`;
    const timeText = formatTimeRemainingShort(result.quota.resetsAt);

    const html =
      `<table ${tbl}>` +
        `<tr>` +
          `<td></td>` +
          `<th colspan="2" ${hCell()}>${t.monthly}</th>` +
        `</tr>` +
        `<tr>` +
          `<td></td>` +
          `<th ${subH()}>${t.leftLabel}</th>` +
          `<th ${subH()}>${t.resetsIn}</th>` +
        `</tr>` +
        `<tr>` +
          `<td ${emojiCell}>${emoji}</td>` +
          `<td ${cell('right')}>${pctText}</td>` +
          `<td ${cell('left')}>${timeText}</td>` +
        `</tr>` +
      `</table>`;
    md.appendMarkdown(html + '\n\n');

  } else if (providerName === 'Gemini' && Array.isArray(result.geminiModels)) {
    const models = result.geminiModels;
    const tbl  = 'style="border-collapse:collapse;margin:4px 0"';
    const hCell = 'style="padding:4px 14px;text-align:center;border-bottom:1px solid #606060"';
    const subH  = (align = 'center') => `style="padding:2px 14px;text-align:${align};font-weight:normal;color:#999;font-size:0.9em"`;
    const cell  = (align = 'center') => `style="padding:5px 14px;text-align:${align}"`;
    const emojiCell = 'style="padding:5px 8px;text-align:center"';

    let html = `<table ${tbl}><thead>`;
    html += `<tr><td></td><th ${hCell}>${t.group}</th><th ${hCell}>${t.leftLabel}</th><th ${hCell}>${t.resetsIn}</th></tr>`;
    html += `<tr><td></td><th ${subH('left')}></th><th ${subH('right')}>${t.leftLabel}</th><th ${subH('left')}>${t.resetLabel}</th></tr>`;
    html += `</thead><tbody>`;
    for (const m of models) {
      const emoji = getQuotaEmoji(m.leftPercent);
      const pct = m.leftPercent !== null ? `${m.leftPercent}%` : 'Full';
      const time = formatTimeRemainingShort(m.resetsAt);
      html += `<tr>`;
      html += `<td ${emojiCell}>${emoji}</td>`;
      html += `<td ${cell('left')}><b>${m.label}</b></td>`;
      html += `<td ${cell('right')}><b>${pct}</b></td>`;
      html += `<td ${cell('left')}>${time}</td>`;
      html += `</tr>`;
    }
    html += `</tbody></table>`;
    md.appendMarkdown(html + '\n\n');

  } else {
    const groups = Array.isArray(result.groups) && result.groups.length > 0
      ? result.groups
      : (result.rateLimits ? [{ label: providerName, rateLimits: result.rateLimits }] : []);

    if (groups.length === 0) {
      md.appendMarkdown(`_${result.summary || '-'}_\n\n`);
    } else {
      const multi = groups.length > 1;

      let html = `<table ${tbl}><thead>`;

      // 1행: ⏱ 5h (colspan2) ·  · 📅 7d (colspan2)
      html += `<tr>`;
      html += `<td></td>`;
      if (multi) html += `<td></td>`;
      html += `<th colspan="2" ${hCell()}>⏱&nbsp;${t.hourly}</th>`;
      html += sepH;
      html += `<th colspan="2" ${hCell()}>📅&nbsp;${t.weekly}</th>`;
      html += `</tr>`;

      // 2행: 잔여 · 리셋 · (sep) · 잔여 · 리셋
      html += `<tr>`;
      html += `<td></td>`;
      if (multi) html += `<th ${subH('left')}>${t.group}</th>`;
      html += `<th ${subH('right')}>${t.leftLabel}</th>`;
      html += `<th ${subH('left')}>${t.resetLabel}</th>`;
      html += sep;
      html += `<th ${subH('right')}>${t.leftLabel}</th>`;
      html += `<th ${subH('left')}>${t.resetLabel}</th>`;
      html += `</tr>`;

      html += `</thead><tbody>`;

      for (const group of groups) {
        const p = group.rateLimits?.primary;
        const s = group.rateLimits?.secondary;
        const minLeft = Math.min(toLeftPercent(p?.used_percent) ?? 100, toLeftPercent(s?.used_percent) ?? 100);
        const emoji = getQuotaEmoji(minLeft);
        const pPct  = formatLeftPercent(p?.used_percent);
        const pTime = formatTimeRemainingShort(p?.resets_at);
        const sPct  = formatLeftPercent(s?.used_percent);
        const sTime = formatTimeRemainingShort(s?.resets_at);

        html += `<tr>`;
        html += `<td ${emojiCell}>${emoji}</td>`;
        if (multi) html += `<td ${cell('left')}><b>${group.label}</b></td>`;
        html += `<td ${cell('right')}><b>${pPct}</b></td>`;
        html += `<td ${cell('left')}>${pTime}</td>`;
        html += sep;
        html += `<td ${cell('right')}><b>${sPct}</b></td>`;
        html += `<td ${cell('left')}>${sTime}</td>`;
        html += `</tr>`;
      }

      html += `</tbody></table>`;
      md.appendMarkdown(html + '\n\n');
    }
  }

  md.appendMarkdown('---\n\n');
  md.appendMarkdown(`_$(sync) ${t.clickToRefresh}_`);
  return md;
}

function toLeftPercent(usedPercent) {
  if (typeof usedPercent !== 'number') {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((100 - usedPercent) * 10) / 10));
}

function formatLeftPercent(usedPercent) {
  const left = toLeftPercent(usedPercent);
  return left === null ? 'Full' : `${left}%`;
}

function normalizeUtilizationToUsedPercent(utilization) {
  if (typeof utilization !== 'number') {
    return null;
  }
  const raw = utilization <= 1 ? utilization * 100 : utilization;
  return Math.max(0, Math.min(100, raw));
}

function isoToEpochSeconds(value) {
  if (!value) {
    return null;
  }
  // 이미 숫자(epoch-s 또는 epoch-ms)인 경우 처리
  if (typeof value === 'number') {
    return value > 1e12 ? Math.floor(value / 1000) : value;
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    return null;
  }
  return Math.floor(t / 1000);
}

function httpsGetJson(hostname, urlPath, headers, timeoutMs) {
  return httpsRequestJson(hostname, urlPath, 'GET', headers, null, timeoutMs);
}

function httpsRequestJson(hostname, urlPath, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: urlPath, method, headers },
      (res) => {
        let raw = '';
        let totalSize = 0;
        const MAX_RESPONSE_SIZE = 1024 * 1024; // 1 MB guard
        res.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > MAX_RESPONSE_SIZE) {
            req.destroy(new Error('Response too large'));
            return;
          }
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            // 429의 경우 Retry-After 헤더가 있으면 에러 메시지에 포함
            if (res.statusCode === 429) {
              const retryAfter = res.headers['retry-after'];
              const msg = retryAfter
                ? `HTTP 429: retry-after: ${retryAfter}: ${raw.slice(0, 200)}`
                : `HTTP 429: ${raw.slice(0, 200)}`;
              return reject(new Error(msg));
            }
            return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          }
          try {
            return resolve(JSON.parse(raw));
          } catch (err) {
            return reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timed out'));
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function formatCompactNumber(num) {
  if (typeof num !== 'number' || Number.isNaN(num)) {
    return '?';
  }
  if (num >= 1_000_000) {
    return `${Math.round((num / 1_000_000) * 10) / 10}m`;
  }
  if (num >= 1_000) {
    return `${Math.round((num / 1_000) * 10) / 10}k`;
  }
  return String(num);
}

function truncate(value, max) {
  if (!value || value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 3)}...`;
}

module.exports = {
  activate,
  deactivate,
};

