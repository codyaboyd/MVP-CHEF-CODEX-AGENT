const VAGUE_TERMS = ['make it better', 'improve this', 'fix it', 'do the thing', 'stuff', 'etc', 'as needed', 'clean up'];
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bdelete\s+(all|everything|the\s+entire)\b/i,
  /\bdrop\s+(database|table|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bwipe\s+(out\s+)?(all|everything|the\s+repo|database)\b/i,
  /\breset\s+--hard\b/i,
  /\bforce\s+push\b/i
];
const SECRET_PATTERNS = [
  /\b(print|show|display|expose|reveal|dump|log)\b[^.\n]*(secret|token|api[_ -]?key|password|credential|private key|\.env)/i,
  /\b(secret|token|api[_ -]?key|password|credential|private key)\b[^.\n]*\b(print|show|display|expose|reveal|dump|log)\b/i
];
const UNRELATED_FILE_PATTERNS = [
  /\b(entire|whole)\s+(repo|repository|codebase)\b/i,
  /\ball\s+files\b/i,
  /\bunrelated\s+files\b/i,
  /\beverywhere\b/i,
  /\bdrive-by\b/i,
  /\bwhile you'?re there\b/i
];
const ACCEPTANCE_PATTERNS = [/acceptance criteria/i, /done when/i, /definition of done/i, /must pass/i, /should include/i, /verify that/i];
const TEST_PATTERNS = [/\btest(s|ing)?\b/i, /\bbuild\b/i, /\blint\b/i, /\btypecheck\b/i, /npm\s+(run\s+)?(test|build|lint)/i, /cargo\s+test/i, /pytest/i];

function warning(code, message, suggestion) {
  return { code, message, suggestion };
}

function lintPrompt(prompt = '') {
  const text = String(prompt || '');
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  const warnings = [];

  if (!normalized) {
    warnings.push(warning('empty_prompt', 'Prompt is empty.', 'Describe the desired change, files in scope, acceptance criteria, and checks to run.'));
    return warnings;
  }

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount < 8 || VAGUE_TERMS.some((term) => lower.includes(term))) {
    warnings.push(warning('vague_prompt', 'Prompt may be too vague for a safe recipe run.', 'Name the concrete change, intended behavior, constraints, and expected output.'));
  }
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    warnings.push(warning('destructive_instruction', 'Prompt appears to include destructive instructions.', 'Avoid irreversible commands; require backups, dry runs, or explicit review for destructive operations.'));
  }
  if (!ACCEPTANCE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    warnings.push(warning('missing_acceptance_criteria', 'Prompt does not include clear acceptance criteria.', 'Add a “Done when…” or “Acceptance criteria” section with measurable outcomes.'));
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(normalized))) {
    warnings.push(warning('secret_exposure_request', 'Prompt asks to expose secrets or credentials.', 'Ask to verify secret handling without printing, logging, or committing secret values.'));
  }
  if (UNRELATED_FILE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    warnings.push(warning('unrelated_file_modification', 'Prompt may allow modifying unrelated files.', 'Restrict edits to named files, directories, or the minimal files required for the change.'));
  }
  if (!TEST_PATTERNS.some((pattern) => pattern.test(normalized))) {
    warnings.push(warning('missing_test_instruction', 'Prompt does not say what test, build, or lint command to run.', 'Specify exact verification commands such as npm test, npm run build, or npm run lint.'));
  }

  return warnings;
}

function improvePrompt(prompt = '') {
  const original = String(prompt || '').trim();
  const baseTask = original || '[Describe the specific change to make]';
  return [
    `Task: ${baseTask}`,
    '',
    'Scope:',
    '- Modify only the files required for this task; do not make unrelated refactors or drive-by changes.',
    '- Do not print, expose, commit, or log secrets, tokens, credentials, or .env values.',
    '- Avoid destructive operations unless they are explicitly necessary and reviewed first.',
    '',
    'Acceptance criteria:',
    '- The requested behavior is implemented and documented where appropriate.',
    '- Edge cases and error states relevant to the change are handled.',
    '- Existing behavior outside the stated scope remains unchanged.',
    '',
    'Verification:',
    '- Run the project’s relevant test, lint, and/or build commands and report the exact results.'
  ].join('\n');
}

function formatWarnings(warnings) {
  if (!warnings.length) return '';
  return ['[PromptLint] Warnings:', ...warnings.map((item) => `- ${item.message} ${item.suggestion}`)].join('\n');
}

module.exports = { formatWarnings, improvePrompt, lintPrompt };
