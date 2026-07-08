const db = require('../db');

const DEFAULT_SETTINGS = Object.freeze({
  autoMergeEnabled: 'true',
  requireHumanApprovalBeforeMerge: 'false',
  protectedMainMode: 'true'
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
}

function getSetting(key) {
  ensureDefaultSettings();
  return db.prepare('SELECT * FROM app_settings WHERE key = ?').get(key) || null;
}

function getSettings() {
  ensureDefaultSettings();
  return db.prepare('SELECT * FROM app_settings ORDER BY key ASC').all();
}

function getAutomationSettings(overrides = {}) {
  ensureDefaultSettings();
  const rows = getSettings().reduce((settings, row) => ({ ...settings, [row.key]: row.value }), {});
  return {
    autoMergeEnabled: normalizeBoolean(overrides.autoMergeEnabled ?? rows.autoMergeEnabled, true),
    requireHumanApprovalBeforeMerge: normalizeBoolean(overrides.requireHumanApprovalBeforeMerge ?? rows.requireHumanApprovalBeforeMerge, false),
    protectedMainMode: normalizeBoolean(overrides.protectedMainMode ?? rows.protectedMainMode, true)
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  ensureDefaultSettings,
  getAutomationSettings,
  getSetting,
  getSettings,
  normalizeBoolean
};
