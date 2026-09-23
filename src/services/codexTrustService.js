const path = require('node:path');
const pty = require('node-pty');

const TRUST_PROMPT = /(?:trust|allow)\s+(?:this\s+)?(?:directory|folder|workspace)|(?:directory|folder|workspace).{0,40}(?:trust|trusted)/i;
const UPDATE_PROMPT = /(?:new|newer) version of (?:the )?codex|codex (?:update|upgrade) (?:is )?available|update codex/i;
// Keep this limited to text rendered by Codex's idle composer. The current TUI
// uses "Ask Codex to do anything"; older releases used the other variants.
const READY = /(?:ask codex to do anything|what (?:would you like|can i help)|codex>|type \/help)/i;
const UNKNOWN_PROMPT = /(?:\?|\[y\/n\]|press enter)\s*$/i;

function stripAnsi(value = '') {
  return String(value)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function terminate(term) {
  try { term.kill(); } catch { /* already exited */ }
}

function visibleLines(value) {
  return stripAnsi(value).split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
}

// Codex's full-screen prompts are radio lists, not yes/no questions. Work out
// where the highlighted row is and navigate to the requested row rather than
// assuming that pressing Enter accepts it. This is deliberately restricted to
// recognized Codex startup dialogs.
function navigationForChoice(output, desiredPattern) {
  const optionLines = visibleLines(output).filter((line) => /^(?:(?:›|>|➜|→|●|◉)\s*)?\d+[.)]\s+/u.test(line));
  const selected = optionLines.findIndex((line) => /^(?:›|>|➜|→|●|◉)\s*/u.test(line));
  const desired = optionLines.findIndex((line) => desiredPattern.test(line.replace(/^(?:›|>|➜|→|●|◉)\s*/u, '')));
  if (selected < 0 || desired < 0) return null;
  const direction = desired < selected ? '\x1b[A' : '\x1b[B';
  return direction.repeat(Math.abs(desired - selected));
}

function establishTrust(options) {
  const { cwd, command = 'codex', timeoutMs = 20000, spawnPty = pty.spawn } = options;
  return new Promise((resolve) => {
    let terminal;
    let output = '';
    let answered = false;
    let settled = false;
    let promptTimer;
    let actionTimer;
    let handlingPrompt = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(promptTimer);
      clearTimeout(actionTimer);
      terminate(terminal);
      resolve({ trusted: false, alreadyTrusted: false, ...result });
    };
    const timeout = setTimeout(() => finish({ code: 'TRUST_TIMEOUT', error: 'Codex did not complete workspace trust before the timeout. Retry, or run Codex in this folder once manually.' }), timeoutMs);
    try {
      terminal = spawnPty(command, [], { cwd: path.resolve(cwd), env: process.env, name: 'xterm-256color', cols: 100, rows: 30 });
    } catch (error) {
      clearTimeout(timeout);
      return resolve({ trusted: false, alreadyTrusted: false, code: error.code === 'ENOENT' ? 'CODEX_NOT_FOUND' : 'TRUST_LAUNCH_FAILED', error: error.code === 'ENOENT' ? `Codex CLI executable "${command}" was not found.` : error.message });
    }
    terminal.onData((chunk) => {
      output = stripAnsi((output + chunk).slice(-16384));
      if (handlingPrompt) return;
      if (UPDATE_PROMPT.test(output)) {
        const navigation = navigationForChoice(output, /(?:skip|not now|later|continue without updating)/i);
        if (navigation === null) return;
        handlingPrompt = true;
        if (navigation) terminal.write(navigation);
        actionTimer = setTimeout(() => {
          if (settled) return;
          terminal.write('\r');
          output = '';
          handlingPrompt = false;
        }, navigation ? 100 : 0);
        return;
      }
      if (!answered && TRUST_PROMPT.test(output)) {
        if (/\[[^\]]*y\s*\/\s*n[^\]]*\]/i.test(output)) {
          answered = true;
          terminal.write('y\r');
          output = '';
          return;
        }
        const navigation = navigationForChoice(output, /(?:yes|trust|allow|continue)/i);
        if (navigation === null) return;
        answered = true;
        handlingPrompt = true;
        if (navigation) terminal.write(navigation);
        actionTimer = setTimeout(() => {
          if (settled) return;
          terminal.write('\r');
          output = '';
          handlingPrompt = false;
        }, navigation ? 100 : 0);
        return;
      }
      if (answered && READY.test(output)) return finish({ trusted: true, code: 'TRUSTED' });
      if (!answered && READY.test(output)) return finish({ trusted: true, alreadyTrusted: true, code: 'ALREADY_TRUSTED' });
      if (UNKNOWN_PROMPT.test(output) && !TRUST_PROMPT.test(output)) {
        clearTimeout(promptTimer);
        promptTimer = setTimeout(() => finish({ code: 'UNKNOWN_PROMPT', error: 'Codex displayed an unknown interactive prompt. Open Codex manually in this folder, resolve it, then retry.' }), 750);
      }
    });
    terminal.onExit(({ exitCode }) => {
      if (answered && exitCode === 0) finish({ trusted: true, code: 'TRUSTED' });
      else finish({ code: 'CODEX_EXITED', error: `Codex exited before workspace trust completed (exit ${exitCode}).` });
    });
  });
}

module.exports = { establishTrust, navigationForChoice, stripAnsi, TRUST_PROMPT, UPDATE_PROMPT };
