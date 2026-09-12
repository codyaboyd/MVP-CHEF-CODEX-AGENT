const db = require('../db');
const projectService = require('./projectService');
const runStateManager = require('./runStateManager');
const recipeService = require('./recipeService');
const recipeRunEngine = require('./recipeRunEngine');
const planningService = require('./codexPlanningService');
const trustService = require('./codexTrustService');
const appSettingsService = require('./appSettingsService');
const { validateChain } = require('./wizardChainValidator');

const jobs = new Map();
const allowedStages = ['workspace', 'describe', 'architecture', 'plan', 'chain', 'building'];
function settings() { return Object.fromEntries(appSettingsService.getSettings().map((row) => [row.key, row.value])); }
function get(id) { return db.prepare('SELECT * FROM wizard_sessions WHERE id = ?').get(Number(id)) || null; }
function list(limit = 50) {
  const normalizedLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  return db.prepare(`
    SELECT wizard_sessions.*, projects.name AS project_name, runs.status AS run_status
    FROM wizard_sessions
    LEFT JOIN projects ON projects.id = wizard_sessions.project_id
    LEFT JOIN runs ON runs.id = wizard_sessions.run_id
    ORDER BY wizard_sessions.updated_at DESC, wizard_sessions.id DESC
    LIMIT ?
  `).all(normalizedLimit);
}
function serialize(row) { return row ? { ...row, generatedChain: row.generated_chain ? JSON.parse(row.generated_chain) : null } : null; }
function update(id, patch) {
  const allowed = new Set(['project_id', 'target_directory', 'original_brief', 'architecture', 'production_plan', 'generated_chain', 'recipe_id', 'run_id', 'stage', 'status', 'error']);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (patch.stage && !allowedStages.includes(patch.stage)) throw new Error('Invalid wizard stage.');
  const current = get(id);
  if (!current) throw new Error('Wizard session not found.');
  if (patch.stage && allowedStages.indexOf(patch.stage) < allowedStages.indexOf(current.stage)) throw new Error(`Invalid wizard transition from ${current.stage} to ${patch.stage}.`);
  if (!entries.length) return get(id);
  const params = { id: Number(id) };
  const assignments = entries.map(([key, value]) => { params[key] = value; return `${key}=@${key}`; });
  db.prepare(`UPDATE wizard_sessions SET ${assignments.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run(params);
  return get(id);
}
function create(folderPath) {
  const validation = projectService.validateProjectPath(folderPath);
  if (!validation.ok) throw new Error(validation.message);
  const project = projectService.getOrCreateFolderProject(validation.repoPath);
  runStateManager.assertProjectAvailable(project.id);
  const result = db.prepare('INSERT INTO wizard_sessions (project_id, target_directory) VALUES (?, ?)').run(project.id, validation.repoPath);
  return get(result.lastInsertRowid);
}
function fail(id, error) { return update(id, { status: 'failed', error: String(error.message || error).slice(0, 5000) }); }

async function trust(id, dependencies = {}) {
  const session = get(id);
  if (!session) throw new Error('Wizard session not found.');
  update(id, { status: 'trusting_workspace', error: null });
  const config = settings();
  const result = await (dependencies.trustService || trustService).establishTrust({ cwd: session.target_directory, command: config.codexCommandPath || 'codex' });
  if (!result.trusted) { fail(id, new Error(result.error)); return result; }
  update(id, { stage: 'describe', status: 'ready_for_description', error: null });
  return result;
}

const architecturePrompt = (session) => `You are the principal software architect. DO NOT modify files. Inspect existing files in ${session.target_directory} read-only when present and account for the current implementation. Treat the exact product brief below as the specification, resolve obvious implementation details without unnecessary questions, and produce a detailed architecture for another coding agent. Cover product and functional/non-functional requirements, boundaries, stack and rationale, modules, frontend, backend, APIs, data, state, auth, integrations, async work, caching, storage, configuration and secrets, security, errors, logging/observability, testing, development, deployment/CI/CD, scaling, performance, accessibility, compatibility, migrations, edge cases, decisions, and measurable acceptance criteria.\n\nORIGINAL BRIEF (preserve its meaning):\n${session.original_brief}`;
const planPrompt = (session) => `DO NOT modify files. Create a concrete dependency-ordered 0-to-100 production implementation roadmap targeting zero known bugs. Include initialization, dependencies, schemas/migrations, logic, APIs, UI/UX, auth, integrations, validation and failure paths, concurrency, security and sanitization, secrets, accessibility/responsiveness, performance/reliability/observability, unit/integration/e2e/regression/failure tests, package/build validation, production config, deployment, documentation, cleanup, dependency/security review, QA and release readiness. No vague tasks; every task needs verification and acceptance criteria.\n\nORIGINAL BRIEF:\n${session.original_brief}\n\nARCHITECTURE:\n${session.architecture}`;
const chainPrompt = (session, repair = '') => `DO NOT modify files. Transform the artifacts below into a complete ordered MVP Chef implementation chain. Return ONLY strict JSON with name, version, description, ingredients, and steps. Every step needs title, a self-contained prompt, requiredChecks array, maxRetries (normally 2), requiresApproval false. Generate as many small coherent steps as complexity requires—dozens are welcome. Each fresh worker prompt must tell Codex to inspect current files, preserve correct work, implement one coherent slice, add tests, run relevant checks, fix its failures, and leave consistency. Never reference hidden conversation. Include recurring verification and final integration, TODO/stub, security, edge case, coverage, UI/UX, accessibility, performance, production config, dependency, docs, clean install/build, regression, bug-fix, and production-readiness audits. Final prompt must fix findings. ${repair}\n\nORIGINAL BRIEF:\n${session.original_brief}\n\nARCHITECTURE:\n${session.architecture}\n\nPRODUCTION PLAN:\n${session.production_plan}`;

async function runPlanningPass(id, kind, dependencies = {}) {
  let session = get(id);
  if (!session) throw new Error('Wizard session not found.');
  const config = settings();
  const executor = dependencies.planningService || planningService;
  const prompts = { architecture: architecturePrompt, plan: planPrompt, chain: chainPrompt };
  const statuses = { architecture: 'generating_architecture', plan: 'generating_production_plan', chain: 'generating_implementation_chain' };
  update(id, { stage: kind, status: statuses[kind], error: null });
  try {
    const result = await executor.executePlanning({ sessionId: id, cwd: session.target_directory, prompt: prompts[kind](session), command: config.codexCommandPath || 'codex', model: config.codexModel || '', reasoningEffort: config.codexReasoningEffort || 'medium' });
    if (kind === 'architecture') return update(id, { architecture: result.answer, stage: 'plan', status: 'architecture_complete' });
    if (kind === 'plan') return update(id, { production_plan: result.answer, stage: 'chain', status: 'production_plan_complete' });
    let chain;
    try { chain = validateChain(result.answer); } catch (firstError) {
      const repaired = await executor.executePlanning({ sessionId: id, cwd: session.target_directory, prompt: chainPrompt(session, `The previous output was invalid (${firstError.message}). Repair the format once.`), command: config.codexCommandPath || 'codex', model: config.codexModel || '', reasoningEffort: config.codexReasoningEffort || 'medium' });
      chain = validateChain(repaired.answer);
    }
    return update(id, { generated_chain: JSON.stringify(chain), status: 'chain_complete' });
  } catch (error) { if (get(id)?.status !== 'cancelled') fail(id, error); throw error; }
}

async function generate(id, brief, dependencies = {}) {
  const normalized = String(brief || '');
  if (!normalized.trim()) throw new Error('A detailed software build brief is required.');
  update(id, { original_brief: normalized, error: null });
  for (const kind of ['architecture', 'plan', 'chain']) {
    const session = get(id);
    if ((kind === 'architecture' && session.architecture) || (kind === 'plan' && session.production_plan) || (kind === 'chain' && session.generated_chain)) continue;
    await runPlanningPass(id, kind, dependencies);
  }
  return launch(id, dependencies);
}

async function launch(id, dependencies = {}) {
  const session = get(id);
  if (!session?.generated_chain) throw new Error('A valid generated chain is required before launch.');
  runStateManager.assertProjectAvailable(session.project_id);
  let recipeId = session.recipe_id;
  if (!recipeId) {
    const chain = validateChain(session.generated_chain);
    const recipe = (dependencies.recipeService || recipeService).createRecipe({ title: chain.name, phase: chain.version, summary: chain.description, ingredients: chain.ingredients.join('\n'), projectId: session.project_id, steps: chain.steps.map((step) => ({ ...step, retryCount: step.maxRetries })), isSaved: true });
    recipeId = recipe.id;
    update(id, { recipe_id: recipeId, status: 'creating_recipe' });
  }
  const engine = dependencies.recipeRunEngine || recipeRunEngine;
  const run = await engine.startRunFromRecipe(recipeId, { autoExecute: false });
  update(id, { run_id: run.id, stage: 'building', status: 'build_running', error: null });
  engine.resumeRun(run.id, { gitEnabled: false }).catch((error) => console.error(error));
  return get(id);
}

function startBackground(id, brief) {
  if (jobs.has(Number(id))) return false;
  const job = generate(id, brief).catch((error) => fail(id, error)).finally(() => jobs.delete(Number(id)));
  jobs.set(Number(id), job);
  return true;
}
function cancel(id) { const cancelled = planningService.cancel(id); update(id, { status: 'cancelled', error: null }); return cancelled; }

module.exports = { architecturePrompt, cancel, chainPrompt, create, generate, get, launch, list, planPrompt, runPlanningPass, serialize, startBackground, trust, update, _jobs: jobs };
