document.documentElement.classList.add('js-enabled');

function refreshStepNumbers(list) {
  list.querySelectorAll('[data-step-editor]').forEach((step, index) => {
    step.querySelector('.step-number').textContent = `Step ${index + 1}`;
  });
}

function resetPromptHelpers(step) {
  step.querySelectorAll('[data-prompt-helper-status]').forEach((status) => {
    status.textContent = 'Uses local prompt linting rules; no external APIs are called.';
  });
}

function createStep(list) {
  const firstStep = list.querySelector('[data-step-editor]');
  const step = firstStep.cloneNode(true);
  step.querySelectorAll('input, textarea').forEach((field) => {
    if (field.name === 'stepRetryCounts') {
      field.value = field.name === 'stepApprovalOverrides' ? 'inherit' : '0';
    } else if (field.name === 'stepTitles') {
      field.value = `Step ${list.querySelectorAll('[data-step-editor]').length + 1}`;
    } else {
      field.value = '';
    }
  });
  step.querySelectorAll('select').forEach((field) => {
    field.value = field.name === 'stepApprovalOverrides' ? 'inherit' : '0';
  });
  resetPromptHelpers(step);
  return step;
}


document.querySelectorAll('[data-project-form]').forEach((form) => {
  const folderInput = form.querySelector('[data-project-folder-selector]');
  const pathInput = form.querySelector('[data-project-path]');
  const status = form.querySelector('[data-project-folder-status]');
  if (!folderInput || !pathInput) return;

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  folderInput.addEventListener('change', async () => {
    const [firstFile] = folderInput.files || [];
    if (!firstFile) return;

    if (firstFile.path) {
      const relativeParts = (firstFile.webkitRelativePath || firstFile.name).split('/').filter(Boolean);
      const absoluteParts = firstFile.path.split(/[\\/]/);
      const folderPartCount = Math.max(relativeParts.length - 1, 0);
      pathInput.value = absoluteParts.slice(0, absoluteParts.length - folderPartCount - 1).join(firstFile.path.includes('\\') ? '\\' : '/');
      setStatus(`✅ Selected ${pathInput.value}`);
      return;
    }

    const folderName = (firstFile.webkitRelativePath || firstFile.name).split('/')[0];
    setStatus(`Resolving “${folderName}” on the server…`);

    try {
      const response = await fetch(`/projects/resolve-folder?name=${encodeURIComponent(folderName)}`);
      const result = response.ok ? await response.json() : null;
      if (result && result.ok && result.path) {
        pathInput.value = result.path;
        setStatus(`✅ Selected ${result.path}`);
        return;
      }
      if (result && result.matches && result.matches.length > 1) {
        setStatus(`Selected “${folderName}”. Multiple matching server folders were found; paste the full path before saving.`);
        return;
      }
    } catch {
      // Fall through to the manual-path guidance below.
    }

    setStatus(`Selected “${folderName}”. Your browser does not expose absolute paths and the server could not resolve it automatically, so paste the full server path before saving.`);
  });
});

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

    if (event.target.matches('[data-improve-prompt]')) {
      const prompt = editor.querySelector('textarea[name="stepPrompts"]');
      const status = editor.querySelector('[data-prompt-helper-status]');
      if (status) status.textContent = 'Improving prompt locally…';
      fetch('/prompts/improve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt ? prompt.value : '' })
      })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error('Unable to improve prompt.')))
        .then((data) => {
          if (prompt) prompt.value = data.improvedPrompt || prompt.value;
          if (status) status.textContent = 'Prompt improved locally; review before saving.';
        })
        .catch(() => {
          if (status) status.textContent = 'Prompt helper failed locally. Please edit manually.';
        });
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
  const fileStatus = form.querySelector('[data-import-file-status]');

  fileInput.addEventListener('change', async () => {
    const [file] = fileInput.files;
    if (!file) return;

    if (fileStatus) fileStatus.textContent = `⏳ Loading ${file.name}…`;
    jsonInput.value = await file.text();
    if (fileStatus) fileStatus.textContent = `✅ Loaded ${file.name} (${Math.ceil(file.size / 1024)} KB)`;
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
        ${step.status === 'waiting_for_approval' ? `
          <div class="approval-panel alert alert-info mt-2">
            <strong>Human approval required:</strong> ${escapeHtml(step.errorMessage || 'Review this checkpoint.')}
            <div class="d-flex flex-wrap gap-2 mt-2">
              <form method="post" action="/runs/${snapshot.id}/steps/${step.id}/approve"><input type="hidden" name="approvalPoint" value="${escapeHtml(step.approvalPoint || '')}"><button class="btn btn-sm btn-success" type="submit">Approve</button></form>
              <form method="post" action="/runs/${snapshot.id}/steps/${step.id}/reject"><input class="form-control form-control-sm" name="reason" placeholder="Reject reason"><button class="btn btn-sm btn-outline-danger mt-1" type="submit">Reject</button></form>
              <form method="post" action="/runs/${snapshot.id}/steps/${step.id}/skip"><button class="btn btn-sm btn-outline-secondary" type="submit">Skip step</button></form>
              <form method="post" action="/runs/${snapshot.id}/cancel"><button class="btn btn-sm btn-danger" type="submit">Cancel run</button></form>
            </div>
            <form method="post" action="/runs/${snapshot.id}/steps/${step.id}/edit-retry" class="mt-2"><label class="form-label small fw-bold">Edit prompt and retry</label><textarea class="form-control form-control-sm" name="prompt" rows="3">${escapeHtml(step.promptOverride || step.prompt || '')}</textarea><button class="btn btn-sm btn-primary mt-1" type="submit">Retry with edited prompt</button></form>
          </div>` : ''}
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
