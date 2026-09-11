const wizardService = require('../services/wizardService');

function render(res, session = null, errors = [], status = 200) {
  res.status(status).render('wizard', { title: 'Wizard Build', session: wizardService.serialize(session), errors });
}
function index(_req, res) { render(res); }
function show(req, res, next) { const session = wizardService.get(req.params.id); if (!session) return next(); render(res, session); }
async function selectWorkspace(req, res) {
  try {
    const session = wizardService.create(String(req.body.folderPath || ''));
    const result = await wizardService.trust(session.id);
    if (!result.trusted) return render(res, wizardService.get(session.id), [result.error], 422);
    res.redirect(`/wizard/${session.id}`);
  } catch (error) {
    if (error.code === 'PROJECT_RUN_LOCKED') return render(res, null, ['That project is already owned by an active MVP Chef run. Finish or cancel it first.'], 409);
    render(res, null, [error.message], 400);
  }
}
async function retryTrust(req, res) {
  try {
    const result = await wizardService.trust(req.params.id);
    if (!result.trusted) return render(res, wizardService.get(req.params.id), [result.error], 422);
    res.redirect(`/wizard/${req.params.id}`);
  } catch (error) { render(res, wizardService.get(req.params.id), [error.message], 400); }
}
function generate(req, res) {
  const session = wizardService.get(req.params.id);
  if (!session) return res.status(404).json({ ok: false, message: 'Wizard session not found.' });
  const brief = Object.prototype.hasOwnProperty.call(req.body, 'brief') ? String(req.body.brief) : session.original_brief;
  if (!brief.trim()) return render(res, session, ['A detailed software build brief is required.'], 400);
  wizardService.startBackground(session.id, brief);
  res.redirect(`/wizard/${session.id}`);
}
function retry(req, res) {
  const session = wizardService.get(req.params.id);
  if (!session) return res.status(404).json({ ok: false, message: 'Wizard session not found.' });
  if (session.generated_chain) wizardService.launch(session.id).catch((error) => wizardService.update(session.id, { status: 'failed', error: error.message }));
  else wizardService.startBackground(session.id, session.original_brief);
  res.redirect(`/wizard/${session.id}`);
}
function status(req, res) {
  const session = wizardService.get(req.params.id);
  if (!session) return res.status(404).json({ ok: false, message: 'Wizard session not found.' });
  const value = wizardService.serialize(session);
  res.json({ ok: true, id: value.id, stage: value.stage, status: value.status, error: value.error, stepCount: value.generatedChain?.steps?.length || 0, runId: value.run_id });
}
function cancel(req, res) { wizardService.cancel(req.params.id); res.redirect(`/wizard/${req.params.id}`); }

module.exports = { cancel, generate, index, retry, retryTrust, selectWorkspace, show, status };
