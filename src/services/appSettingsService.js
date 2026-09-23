const db = require('../db');

const CODEX_MODEL_OPTIONS = Object.freeze([
  { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
  { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
  { value: 'gpt-6-luna', label: 'GPT-6-Luna' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }
]);

const DEFAULT_SETTINGS = Object.freeze({
  codexCommandPath: 'codex',
  codexConfigDir: '',
  codexModel: '',
  codexReasoningEffort: 'medium',
  codexSandboxMode: 'workspace-write',
  defaultBranch: 'main',
  maxParallelRuns: '1',
  compactUiMode: 'false',
  showAdvancedSettings: 'true',
  defaultCooldownMinutes: '60',
  autoResumeAfterCooldown: 'true',
  maxRetriesAfterQuota: '3',
  projectSafeModeDefault: 'false',
  secretScannerAllowOverride: 'false'
});

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    if (/^(true|yes|on|enabled)$/i.test(value.trim())) return true;
    if (/^(false|no|off|disabled)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function ensureDefaultSettings() {
  const insert = db.prepare(`
    INSERT INTO app_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  Object.entries(DEFAULT_SETTINGS).forEach(([key, value]) => insert.run(key, value));
  // These legacy settings stored credentials and selected API-key authentication.
  // Codex authentication is now owned entirely by the CLI.
  db.prepare('DELETE FROM app_settings WHERE key IN (?, ?)').run('codexApiKey', 'codexAuthMode');
}

function getSetting(key) {
  ensureDefaultSettings();
  return db.prepare('SELECT * FROM app_settings WHERE key = ?').get(key) || null;
}

function getSettings() {
  ensureDefaultSettings();
  return db.prepare('SELECT * FROM app_settings ORDER BY key ASC').all();
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function updateSettings(values = {}) {
  ensureDefaultSettings();
  const update = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  Object.keys(DEFAULT_SETTINGS).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) update.run(key, String(values[key]));
  });
  return getSettings();
}

function getQuotaSettings(overrides = {}) {
  ensureDefaultSettings();
  const rows = getSettings().reduce((settings, row) => ({ ...settings, [row.key]: row.value }), {});
  return {
    defaultCooldownMinutes: normalizeInteger(overrides.defaultCooldownMinutes ?? rows.defaultCooldownMinutes, 60),
    autoResumeAfterCooldown: normalizeBoolean(overrides.autoResumeAfterCooldown ?? rows.autoResumeAfterCooldown, true),
    maxRetriesAfterQuota: normalizeInteger(overrides.maxRetriesAfterQuota ?? rows.maxRetriesAfterQuota, 3)
  };
}

module.exports = {
  CODEX_MODEL_OPTIONS,
  DEFAULT_SETTINGS,
  ensureDefaultSettings,
  getQuotaSettings,
  getSetting,
  getSettings,
  normalizeBoolean,
  normalizeInteger,
  updateSettings
};
