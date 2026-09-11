const MAX_TITLE = 240;
const MAX_PROMPT = 100000;
const MAX_STEPS = 250;

function extractJson(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(source);
}

function validateChain(input, { minimumSteps = 8 } = {}) {
  const recipe = typeof input === 'string' ? extractJson(input) : input;
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw new Error('Generated chain must be a JSON object.');
  if (typeof recipe.name !== 'string' || !recipe.name.trim()) throw new Error('Generated chain requires a name.');
  if (!Array.isArray(recipe.steps) || recipe.steps.length < minimumSteps || recipe.steps.length > MAX_STEPS) throw new Error(`Generated chain must contain between ${minimumSteps} and ${MAX_STEPS} steps.`);
  const seen = new Set();
  const steps = recipe.steps.map((step, index) => {
    if (!step || typeof step !== 'object') throw new Error(`Step ${index + 1} must be an object.`);
    const title = typeof step.title === 'string' ? step.title.trim() : '';
    const prompt = typeof step.prompt === 'string' ? step.prompt.trim() : '';
    if (!title || title.length > MAX_TITLE) throw new Error(`Step ${index + 1} has an invalid title.`);
    if (!prompt || prompt.length > MAX_PROMPT) throw new Error(`Step ${index + 1} has an invalid prompt.`);
    const fingerprint = `${title.toLowerCase()}\0${prompt.toLowerCase()}`;
    if (seen.has(fingerprint)) throw new Error(`Step ${index + 1} duplicates an earlier step.`);
    seen.add(fingerprint);
    return { title, prompt, requiredChecks: Array.isArray(step.requiredChecks) ? step.requiredChecks.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 30) : [], maxRetries: Math.min(5, Math.max(0, Number.isInteger(step.maxRetries) ? step.maxRetries : 2)), requiresApproval: Boolean(step.requiresApproval) };
  });
  return { name: recipe.name.trim().slice(0, 240), version: typeof recipe.version === 'string' ? recipe.version.trim().slice(0, 40) || '1.0.0' : '1.0.0', description: typeof recipe.description === 'string' ? recipe.description.trim().slice(0, 5000) : 'Complete Wizard-generated implementation chain.', ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients.filter((x) => typeof x === 'string').slice(0, 30) : [], steps };
}

module.exports = { extractJson, validateChain, MAX_STEPS };
