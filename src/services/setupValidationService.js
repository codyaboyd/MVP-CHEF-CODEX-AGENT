const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appSettingsService = require('./appSettingsService');

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeoutMs || 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, error, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}


const CODEX_COMMAND_CANDIDATES = Object.freeze(['codex', '/snap/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex']);

async function findUsableCodexCommand(preferredCommand = 'codex') {
  const candidates = [preferredCommand, ...CODEX_COMMAND_CANDIDATES].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const version = await runCommand(candidate, ['--version']);
    if (version.ok) return { command: candidate, version };
  }
  return null;
}

function rowsByKey() {
  appSettingsService.ensureDefaultSettings();
  return appSettingsService.getSettings().reduce((all, row) => ({ ...all, [row.key]: row.value }), {});
}

function configDirLooksReady(configDir) {
  if (!configDir) return false;
  const resolved = configDir.replace(/^~(?=$|\/|\\)/, os.homedir());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return false;
  return fs.readdirSync(resolved).some((entry) => /config|auth|credentials|token|json|toml/i.test(entry));
}

async function validateCodexSetup(overrides = {}) {
  const settings = { ...rowsByKey(), ...overrides };
  const command = settings.codexCommandPath || 'codex';
  const checks = [];
  let version = await runCommand(command, ['--version']);
  let resolvedCommand = command;
  if (!version.ok) {
    const discovered = await findUsableCodexCommand(command);
    if (discovered) {
      resolvedCommand = discovered.command;
      version = discovered.version;
      if (resolvedCommand !== command) {
        appSettingsService.updateSettings({ codexCommandPath: resolvedCommand });
      }
    }
  }
  checks.push({
    key: 'codex_cli_available',
    label: 'Codex CLI is available',
    ok: version.ok,
    detail: version.ok ? `${version.stdout || version.stderr || `${resolvedCommand} responded`} (${resolvedCommand})` : (version.error?.code === 'ENOENT' ? `${command} was not found on PATH or common install locations such as /snap/bin/codex.` : version.stderr || version.error?.message || 'Codex command failed.')
  });

  const authMode = settings.codexAuthMode || 'environment';
  let authOk = false;
  let authDetail = '';
  if (authMode === 'api_key') {
    authOk = Boolean(settings.codexApiKey || process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
    authDetail = authOk ? 'API key is configured.' : 'No API key found in settings, OPENAI_API_KEY, or CODEX_API_KEY.';
  } else if (authMode === 'config_dir') {
    authOk = configDirLooksReady(settings.codexConfigDir);
    authDetail = authOk ? `Config directory looks ready: ${settings.codexConfigDir}` : 'Configured Codex config directory is missing or empty.';
  } else {
    authOk = Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || configDirLooksReady(settings.codexConfigDir) || configDirLooksReady(path.join(os.homedir(), '.codex')));
    authDetail = authOk ? 'Environment or Codex config appears to contain credentials.' : 'No Codex auth signal found; run `codex login` or configure environment credentials.';
  }
  checks.push({ key: 'codex_auth_ready', label: 'Codex auth is configured', ok: authOk, detail: authDetail });
  return { ok: checks.every((check) => check.ok), checks };
}

async function validateGitHubSetup(overrides = {}) {
  const settings = { ...rowsByKey(), ...overrides };
  const enabled = appSettingsService.normalizeBoolean(settings.githubAutomationEnabled, true);
  const checks = [{
    key: 'github_automation_enabled',
    label: 'GitHub automation is enabled',
    ok: enabled,
    skipped: !enabled,
    detail: enabled ? 'GitHub PR/check/merge automation will be available.' : 'GitHub automation is disabled; runs stay local and do not require gh.'
  }];
  if (!enabled) return { ok: true, checks };

  const command = settings.githubCliPath || 'gh';
  const version = await runCommand(command, ['--version']);
  checks.push({
    key: 'github_cli_available',
    label: 'GitHub CLI is available',
    ok: version.ok,
    detail: version.ok ? (version.stdout.split('\n')[0] || `${command} responded`) : (version.error?.code === 'ENOENT' ? `${command} was not found on PATH.` : version.stderr || version.error?.message || 'gh command failed.')
  });
  if (version.ok) {
    const auth = await runCommand(command, ['auth', 'status']);
    checks.push({
      key: 'github_auth_ready',
      label: 'GitHub CLI is authenticated',
      ok: auth.ok,
      detail: auth.ok ? 'gh auth status succeeded.' : auth.stderr || auth.stdout || 'Run `gh auth login`.'
    });
  } else {
    checks.push({ key: 'github_auth_ready', label: 'GitHub CLI is authenticated', ok: false, detail: 'Skipped because gh is unavailable.' });
  }
  return { ok: checks.every((check) => check.ok), checks };
}

async function validateSetup(overrides = {}) {
  const [codex, github] = await Promise.all([validateCodexSetup(overrides), validateGitHubSetup(overrides)]);
  return { ok: codex.ok && github.ok, codex, github };
}

module.exports = { findUsableCodexCommand, validateCodexSetup, validateGitHubSetup, validateSetup };
