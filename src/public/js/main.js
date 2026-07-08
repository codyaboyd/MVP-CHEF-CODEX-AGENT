document.documentElement.classList.add('js-enabled');

function refreshStepNumbers(list) {
  list.querySelectorAll('[data-step-editor]').forEach((step, index) => {
    step.querySelector('.step-number').textContent = `Step ${index + 1}`;
  });
}

function createStep(list) {
  const firstStep = list.querySelector('[data-step-editor]');
  const step = firstStep.cloneNode(true);
  step.querySelectorAll('input, textarea').forEach((field) => {
    if (field.name === 'stepRetryCounts') {
      field.value = '0';
    } else if (field.name === 'stepTitles') {
      field.value = `Step ${list.querySelectorAll('[data-step-editor]').length + 1}`;
    } else {
      field.value = '';
    }
  });
  step.querySelectorAll('select').forEach((field) => {
    field.value = '0';
  });
  return step;
}

document.querySelectorAll('[data-recipe-form]').forEach((form) => {
  const list = form.querySelector('[data-step-list]');

  form.querySelector('[data-add-step]').addEventListener('click', () => {
    list.append(createStep(list));
    refreshStepNumbers(list);
  });

  list.addEventListener('click', (event) => {
    const editor = event.target.closest('[data-step-editor]');
    if (!editor) return;

    if (event.target.matches('[data-delete-step]')) {
      if (list.querySelectorAll('[data-step-editor]').length > 1) {
        editor.remove();
        refreshStepNumbers(list);
      }
      return;
    }

    const direction = event.target.getAttribute('data-move-step');
    if (direction === 'up' && editor.previousElementSibling) {
      list.insertBefore(editor, editor.previousElementSibling);
      refreshStepNumbers(list);
    }
    if (direction === 'down' && editor.nextElementSibling) {
      list.insertBefore(editor.nextElementSibling, editor);
      refreshStepNumbers(list);
    }
  });
});

document.querySelectorAll('[data-recipe-import-form]').forEach((form) => {
  const fileInput = form.querySelector('[data-recipe-json-file]');
  const jsonInput = form.querySelector('textarea[name="recipeJson"]');

  fileInput.addEventListener('change', async () => {
    const [file] = fileInput.files;
    if (!file) return;

    jsonInput.value = await file.text();
  });
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', '\'': '&#39;' }[char]));
}

function setStatusBadge(element, status) {
  if (!element) return;
  element.textContent = status || 'unknown';
  element.dataset.status = status || 'unknown';
  element.className = `status-badge status-${status || 'unknown'}`;
}

function updateRunControls(root, snapshot) {
  const terminalStatuses = ['succeeded', 'failed', 'cancelled'];
  const status = snapshot.status;
  const pause = root.querySelector('[data-run-pause]');
  const resume = root.querySelector('[data-run-resume]');
  const cancel = root.querySelector('[data-run-cancel]');
  if (pause) pause.disabled = terminalStatuses.includes(status) || status === 'paused';
  if (resume) resume.disabled = terminalStatuses.includes(status) || status === 'running';
  if (cancel) cancel.disabled = terminalStatuses.includes(status);
}

function renderRunSteps(root, snapshot) {
  const list = root.querySelector('[data-run-steps]');
  if (!list) return;
  list.innerHTML = snapshot.steps.map((step) => `
    <div class="timeline-item ${snapshot.currentStep && snapshot.currentStep.id === step.id ? 'is-current' : ''}" data-step-id="${step.id}">
      <span>${step.order}</span>
      <div>
        <strong>${escapeHtml(step.title)}</strong> <span class="status-badge status-${step.status}" data-status="${step.status}">${step.status}</span>
        <p>${escapeHtml(step.prompt || '')}</p>
        <small>Retries: ${step.retryAttempts}/${step.maxRetries}</small>
        <div class="quality-gates mt-2">
          <strong>Quality gates</strong>
          ${(step.checks || []).map((check) => `
            <details class="quality-gate quality-gate-${check.status}">
              <summary>${escapeHtml(check.name)} · ${escapeHtml(check.status)} · ${check.required ? 'required' : 'optional'}</summary>
              <code>${escapeHtml(check.command || 'No command configured')}</code>
              <pre>${escapeHtml([check.stdout, check.stderr].filter(Boolean).join('\\n') || 'No output captured.')}</pre>
            </details>
          `).join('') || '<p class="small text-muted mb-0">No checks have run yet.</p>'}
          ${step.qualityGateOverride ? `<p class="small text-warning mb-0">Manual override: ${escapeHtml(step.qualityGateOverrideReason || 'No reason supplied.')}</p>` : ''}
        </div>
      </div>
    </div>
  `).join('') || '<div class="timeline-item"><span>1</span><div><strong>Preheat Codex</strong><p>No run steps have been recorded yet.</p></div></div>';
}

function updateRunDetail(root, snapshot) {
  setStatusBadge(root.querySelector('[data-run-status]'), snapshot.status);
  const currentStep = root.querySelector('[data-run-current-step]');
  if (currentStep) currentStep.textContent = snapshot.currentStep ? snapshot.currentStep.title : 'Complete';
  const retries = root.querySelector('[data-run-retries]');
  if (retries) retries.textContent = snapshot.retryAttempts;
  const commit = root.querySelector('[data-run-commit]');
  if (commit) commit.textContent = snapshot.commitSha || 'Pending';
  const progress = root.querySelector('[data-run-progress]');
  const progressLabel = root.querySelector('[data-run-progress-label]');
  if (progress) {
    progress.style.width = `${snapshot.progress}%`;
    progress.textContent = `${snapshot.progress}%`;
    progress.parentElement.setAttribute('aria-valuenow', snapshot.progress);
  }
  if (progressLabel) progressLabel.textContent = `${snapshot.progress}%`;
  const quota = root.querySelector('[data-quota-status]');
  if (quota && snapshot.quotaStatus) {
    quota.classList.toggle('d-none', !snapshot.quotaStatus.waiting);
    const message = quota.querySelector('[data-quota-message]');
    const refill = quota.querySelector('[data-quota-refill]');
    const retry = quota.querySelector('[data-quota-retry]');
    if (message) message.textContent = snapshot.quotaStatus.message || '';
    if (refill) refill.textContent = snapshot.quotaStatus.refillAt || 'Not set';
    if (retry) retry.textContent = snapshot.quotaStatus.retryCount || 0;
  }
  const logs = root.querySelector('[data-run-logs]');
  if (logs) {
    logs.textContent = [snapshot.stdout, snapshot.stderr ? `\n[stderr]\n${snapshot.stderr}` : ''].filter(Boolean).join('') || 'Waiting for logs…';
    const terminal = root.querySelector('[data-run-terminal]');
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }
  renderRunSteps(root, snapshot);
  updateRunControls(root, snapshot);
}

document.querySelectorAll('[data-run-detail]').forEach((root) => {
  if (!window.EventSource) return;
  const runId = root.getAttribute('data-run-id');
  const connection = root.querySelector('[data-run-connection]');
  const source = new EventSource(`/runs/${runId}/events`);
  if (connection) connection.textContent = 'Live';
  source.addEventListener('run-update', (event) => {
    if (connection) connection.textContent = 'Live';
    updateRunDetail(root, JSON.parse(event.data));
  });
  source.onerror = () => {
    if (connection) connection.textContent = 'Reconnecting';
  };
});
