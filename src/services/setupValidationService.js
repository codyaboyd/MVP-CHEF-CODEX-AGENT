const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appSettingsService = require('./appSettingsService');

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let executable = command;
    let commandArgs = args;
    if (process.platform === 'win32' && /\.cmd$/i.test(command)) {
      executable = process.env.ComSpec || 'cmd.exe';
      const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
      commandArgs = ['/d', '/s', '/c', [quote(command), ...args.map(quote)].join(' ')];
    }
    execFile(executable, commandArgs, { maxBuffer: 1024 * 1024, windowsHide: true, env: options.env || process.env }, (error, stdout, stderr) => {
      resolve({ ok: !error, error, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}


function codexCommandCandidates(platform = process.platform, environment = process.env) {
  const candidates = ['codex'];
  if (platform === 'win32') {
    const appData = environment.APPDATA;
    const localAppData = environment.LOCALAPPDATA;
    if (appData) candidates.push(path.join(appData, 'npm', 'codex.cmd'));
    if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'codex', 'codex.exe'));
  } else {
    candidates.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex');
    if (platform === 'linux') candidates.push('/snap/bin/codex');
  }
  return [...new Set(candidates)];
}

async function findUsableCodexCommand(preferredCommand = 'codex') {
  const candidates = [preferredCommand, ...codexCommandCandidates()].filter(Boolean);
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

function codexConfigCandidates() {
  const homeCandidates = [];
  try {
    fs.readdirSync('/home', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .forEach((entry) => homeCandidates.push(path.join('/home', entry.name, '.codex')));
  } catch {
    // /home is optional in containers and on non-Unix hosts.
  }
  return [...new Set([
    process.env.CODEX_HOME,
    path.join(os.homedir(), '.codex'),
    path.join(process.cwd(), '.codex'),
    ...homeCandidates
  ].filter(Boolean))];
}

function findCodexConfigDir(preferredDir = '') {
  const candidates = [preferredDir, ...codexConfigCandidates()]
    .map((candidate) => candidate.replace(/^~(?=$|\/|\\)/, os.homedir()));
  return candidates.find(configDirLooksReady)
    || candidates.find((candidate) => {
      try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
    })
    || null;
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
    detail: version.ok ? `${version.stdout || version.stderr || `${resolvedCommand} responded`} (${resolvedCommand})` : (version.error?.code === 'ENOENT' ? `${command} was not found on PATH or common install locations for ${process.platform}.` : version.stderr || version.error?.message || 'Codex command failed.')
  });

  const authEnvironment = { ...process.env };
  if (settings.codexConfigDir) authEnvironment.CODEX_HOME = settings.codexConfigDir.replace(/^~(?=$|\/|\\)/, os.homedir());
  const loginStatus = version.ok
    ? await runCommand(resolvedCommand, ['login', 'status'], { env: authEnvironment })
    : { ok: false, stdout: '', stderr: '' };
  const authOk = loginStatus.ok;
  const authDetail = loginStatus.ok
    ? (loginStatus.stdout || loginStatus.stderr || 'Codex CLI reports an active login.')
    : (loginStatus.stderr || loginStatus.stdout || 'Codex CLI is unavailable, or `codex login status` reports no active login. Ensure the app service runs as the user who authenticated.');
  checks.push({ key: 'codex_auth_ready', label: 'Codex auth is configured', ok: authOk, detail: authDetail });
  return { ok: checks.every((check) => check.ok), checks };
}

async function validateSetup(overrides = {}) {
  const codex = await validateCodexSetup(overrides);
  return { ok: codex.ok, codex };
}

module.exports = { codexCommandCandidates, findCodexConfigDir, findUsableCodexCommand, validateCodexSetup, validateSetup };
