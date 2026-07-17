document.documentElement.classList.add('js-enabled');

function attachFolderBrowser(container, onSelect, setStatus) {
  const button = container.querySelector('[data-folder-browser-button]');
  const selector = container.querySelector('[data-folder-browser]');
  if (!button || !selector) return;

  button.addEventListener('click', async () => {
    button.disabled = true;
    setStatus('Scanning Documents, Desktop, Downloads, and workspace folders…');
    try {
      const response = await fetch('/projects/browse-folders');
      const result = await response.json();
      if (!response.ok) throw new Error('Folder scan failed.');
      selector.replaceChildren(new Option('Choose a server folder…', ''));
      (result.folders || []).forEach((folder) => {
        const indent = folder.depth ? `${'— '.repeat(folder.depth)}` : '';
        selector.add(new Option(`${indent}${folder.name}  (${folder.path})`, folder.path));
      });
      selector.hidden = false;
      selector.focus();
      setStatus(result.folders.length
        ? `Found ${result.folders.length} folders. Select one below.`
        : 'No folders were found in the configured server locations. You can still paste an absolute path.');
    } catch {
      setStatus('Unable to scan server folders. Paste an absolute path instead.');
    } finally {
      button.disabled = false;
    }
  });

  selector.addEventListener('change', () => {
    if (selector.value) onSelect(selector.value);
  });
}

document.querySelectorAll('[data-quick-run-form]').forEach((form) => {
  const chain = form.querySelector('[data-prompt-chain]');
  const folderInput = form.querySelector('[data-project-path]');
  const folderStatus = form.querySelector('[data-quick-folder-status]');

  function renumberPrompts() {
    chain.querySelectorAll('[data-prompt-chain-item]').forEach((item, index) => {
      item.querySelector('.prompt-index').textContent = index + 1;
      item.querySelector('[data-remove-prompt]').hidden = chain.children.length === 1;
    });
  }

  form.querySelector('[data-add-prompt]').addEventListener('click', () => {
    const item = chain.firstElementChild.cloneNode(true);
    item.querySelector('textarea').value = '';
    chain.append(item);
    renumberPrompts();
    item.querySelector('textarea').focus();
  });
  chain.addEventListener('click', (event) => {
    if (!event.target.matches('[data-remove-prompt]') || chain.children.length === 1) return;
    event.target.closest('[data-prompt-chain-item]').remove();
    renumberPrompts();
  });
  attachFolderBrowser(form, (folderPath) => {
    folderInput.value = folderPath;
    folderStatus.textContent = `Ready to work in ${folderPath}`;
  }, (message) => { folderStatus.textContent = message; });
  renumberPrompts();
});

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
  const pathInput = form.querySelector('[data-project-path]');
  const status = form.querySelector('[data-project-folder-status]');
  if (!pathInput) return;

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  async function inspectPath() {
    const repoPath = pathInput.value.trim();
    if (!repoPath) return;
    setStatus(`Inspecting ${repoPath}…`);
    try {
      const response = await fetch(`/projects/inspect-path?path=${encodeURIComponent(repoPath)}`);
      const result = await response.json();
      if (!response.ok || !result.ok) {
        setStatus(result.message || 'Unable to inspect that project folder.');
        return;
      }
      Object.entries(result.commands || {}).forEach(([name, value]) => {
        const field = form.querySelector(`[data-detected-command="${name}"]`);
        if (field && value) field.value = value;
      });
      setStatus(`✅ Using ${result.repoPath}; detected ${result.packageManagerName || 'project'} commands.`);
    } catch {
      setStatus('Unable to inspect that project folder. Paste an absolute server path and try again.');
    }
  }

  attachFolderBrowser(form, async (folderPath) => {
    pathInput.value = folderPath;
    await inspectPath();
  }, setStatus);

  pathInput.addEventListener('blur', inspectPath);
  const detectButton = form.querySelector('[data-detect-project-commands]');
  if (detectButton) detectButton.addEventListener('click', inspectPath);
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
