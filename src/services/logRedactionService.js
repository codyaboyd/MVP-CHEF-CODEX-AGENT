const SECRET_KEY_PATTERN = /(SECRET|TOKEN|KEY|PASSWORD|PASS|PWD|AUTH|COOKIE|SESSION|PRIVATE|CREDENTIAL)/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectRuntimeSecrets() {
  return Object.entries(process.env)
    .filter(([key, value]) => SECRET_KEY_PATTERN.test(key) && typeof value === 'string' && value.length >= 4)
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value.length - a.value.length);
}

function redact(input = '') {
  return collectRuntimeSecrets().reduce((output, secret) => {
    return output.replace(new RegExp(escapeRegExp(secret.value), 'g'), `[REDACTED:${secret.key}]`);
  }, String(input));
}

function errorForView(error) {
  if (!error) return null;
  return {
    message: redact(error.message || 'Unexpected error'),
    stack: error.stack ? redact(error.stack) : undefined
  };
}

module.exports = { redact, errorForView };
