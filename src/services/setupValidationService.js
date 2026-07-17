const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const appSettingsService = require('./appSettingsService');

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 1024 * 1024, env: options.env || process.env }, (error, stdout, stderr) => {
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
    const authEnvironment = { ...process.env };
    if (settings.codexConfigDir) {
      authEnvironment.CODEX_HOME = settings.codexConfigDir.replace(/^~(?=$|\/|\\)/, os.homedir());
    }
    const loginStatus = version.ok
      ? await runCommand(resolvedCommand, ['login', 'status'], { env: authEnvironment })
      : { ok: false, stdout: '', stderr: '' };
    const environmentCredential = Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
    authOk = loginStatus.ok || environmentCredential;
    authDetail = loginStatus.ok
      ? (loginStatus.stdout || loginStatus.stderr || 'Codex CLI reports an active login.')
      : environmentCredential
        ? 'An API credential is available in the service environment.'
        : (loginStatus.stderr || loginStatus.stdout || 'Codex CLI is unavailable, or `codex login status` reports no active login. Ensure the app service runs as the user who authenticated.');
  }
  checks.push({ key: 'codex_auth_ready', label: 'Codex auth is configured', ok: authOk, detail: authDetail });
  return { ok: checks.every((check) => check.ok), checks };
}

async function validateSetup(overrides = {}) {
  const codex = await validateCodexSetup(overrides);
  return { ok: codex.ok, codex };
}

module.exports = { findUsableCodexCommand, validateCodexSetup, validateSetup };
