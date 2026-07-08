const fs = require('node:fs');
const path = require('node:path');
const { normalizeBoolean, getSetting } = require('./appSettingsService');

const MAX_FILE_BYTES = 1024 * 1024;
const OVERRIDE_SETTING_KEY = 'secretScannerAllowOverride';

const SECRET_PATTERNS = [
  { type: 'private key', regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  { type: 'OpenAI key', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { type: 'GitHub token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { type: 'Stripe key', regex: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { type: 'API key', regex: /\b(?:api[_-]?key|apikey)\b\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{16,}/i },
  { type: 'token', regex: /\b(?:access[_-]?token|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|token)\b\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{16,}/i },
  { type: 'password', regex: /\b(?:password|passwd|pwd)\b\s*[:=]\s*['\"]?[^\s'\"]{8,}/i }
];

function normalizeChangedFilePath(file) {
  const value = String(file || '').trim();
  if (!value) return '';
  if (value.includes(' -> ')) return value.split(' -> ').pop().trim();
  return value;
}

function isEnvFile(filePath) {
  return path.basename(filePath) === '.env' || /(^|\/)\.env(?:\.|$)/.test(filePath);
}

function hasEnvContent(content) {
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('export ')) return false;
    return /^[A-Z][A-Z0-9_]{2,}\s*=\s*.+$/.test(trimmed);
  });
}

function readTextFile(filePath) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return '';
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return '';
  return buffer.toString('utf8');
}

function scanFile(repoPath, file) {
  const relativePath = normalizeChangedFilePath(file.file || file);
  if (!relativePath || file.status === 'D') return null;
  const repoRoot = path.resolve(repoPath);
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!(absolutePath === repoRoot || absolutePath.startsWith(`${repoRoot}${path.sep}`)) || !fs.existsSync(absolutePath)) return null;

  const findings = [];
  if (isEnvFile(relativePath)) findings.push('.env file');

  let content = '';
  try {
    content = readTextFile(absolutePath);
  } catch {
    return findings.length ? { file: relativePath, findings } : null;
  }

  if (content && hasEnvContent(content)) findings.push('.env content');
  SECRET_PATTERNS.forEach((pattern) => {
    if (pattern.regex.test(content)) findings.push(pattern.type);
  });

  return findings.length ? { file: relativePath, findings: [...new Set(findings)] } : null;
}

function scanChangedFiles(repoPath, changedFiles) {
  return changedFiles.map((file) => scanFile(repoPath, file)).filter(Boolean);
}

function isManualOverrideEnabled(overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, OVERRIDE_SETTING_KEY)) {
    return normalizeBoolean(overrides[OVERRIDE_SETTING_KEY], false);
  }
  const setting = getSetting(OVERRIDE_SETTING_KEY);
  return normalizeBoolean(setting?.value, false);
}

function formatSecretScanWarning(findings) {
  const files = findings.map((finding) => `- ${finding.file} (${finding.findings.join(', ')})`).join('\n');
  return `Potential secrets were detected in changed files. Commit blocked.\n${files}\nRemove the sensitive data or enable the ${OVERRIDE_SETTING_KEY} setting to allow an explicit manual override.`;
}

module.exports = {
  OVERRIDE_SETTING_KEY,
  scanChangedFiles,
  formatSecretScanWarning,
  isManualOverrideEnabled
};
