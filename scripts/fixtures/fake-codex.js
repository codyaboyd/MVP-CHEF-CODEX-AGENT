#!/usr/bin/env node
const { spawn } = require('node:child_process');

const mode = process.env.FAKE_CODEX_MODE || 'stream';
const count = Number(process.env.FAKE_CODEX_EVENTS || 10);

if (mode === 'retry') {
  const fs = require('node:fs');
  const marker = process.env.FAKE_CODEX_MARKER;
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, String(process.pid));
    process.stderr.write('intentional first-attempt failure\n');
    process.exit(17);
  }
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
} else if (mode === 'memory') {
  const allocations = [];
  setInterval(() => allocations.push(Buffer.alloc(4 * 1024 * 1024, 1)), 30);
} else if (mode === 'descendant') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.stdout.write(`${JSON.stringify({ type: 'descendant.started', pid: descendant.pid })}\n`);
  setInterval(() => {}, 1000);
} else {
  for (let index = 0; index < count; index += 1) {
    process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: index, text: 'x'.repeat(512) } })}\n`);
    if (index % 100 === 0) process.stderr.write(`worker diagnostic ${index} ${'y'.repeat(256)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: count, output_tokens: count * 2 } })}\n`);
}
