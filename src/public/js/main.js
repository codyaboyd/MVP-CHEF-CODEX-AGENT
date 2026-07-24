document.documentElement.classList.add('js-enabled');

function attachFolderBrowser(container, onSelect, setStatus) {
  const button = container.querySelector('[data-folder-browser-button]');
  const selector = container.querySelector('[data-folder-browser]');
  const search = container.querySelector('[data-folder-browser-search]');
  if (!button || !selector || !search) return;

  let folders = [];
  function showFolders(query = '') {
    const normalizedQuery = query.trim().toLowerCase();
    const matches = folders.filter((folder) => {
      return !normalizedQuery || `${folder.name} ${folder.path}`.toLowerCase().includes(normalizedQuery);
    });
    selector.replaceChildren(new Option(matches.length ? 'Choose a server folder…' : 'No matching folders', ''));
    matches.forEach((folder) => {
      const indent = folder.depth ? `${'— '.repeat(folder.depth)}` : '';
      selector.add(new Option(`${indent}${folder.name}  (${folder.path})`, folder.path));
    });
    return matches.length;
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    setStatus('Scanning Documents, Desktop, Downloads, and workspace folders…');
    try {
      const response = await fetch('/projects/browse-folders');
      const result = await response.json();
      if (!response.ok) throw new Error('Folder scan failed.');
      folders = result.folders || [];
      showFolders();
      search.hidden = false;
      selector.hidden = false;
      search.focus();
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

  search.addEventListener('input', () => {
    const matchCount = showFolders(search.value);
    setStatus(matchCount
      ? `${matchCount} matching folder${matchCount === 1 ? '' : 's'}.`
      : 'No matching folders. You can still paste an absolute path.');
  });
}

function summarizeCodexEvent(event) {
  const type = event.type || 'event';
  if (type === 'turn.completed') {
    const usage = event.usage ? ` · usage ${JSON.stringify(event.usage)}` : '';
    return `✓ turn completed${usage}`;
  }
  if (type === 'item.completed') {
    const item = event.item || {};
    const title = item.title || item.name || item.type || 'item';
    const content = typeof item.content === 'string' ? ` — ${item.content}` : '';
    return `✓ ${title}${content}`;
  }
  if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
    return event.delta || event.text || '';
  }
  if (type.includes('error') || type.includes('fail')) {
    return `! ${event.message || event.error || JSON.stringify(event)}`;
  }
  return `${type}: ${JSON.stringify(event)}`;
}

function formatCodexStream(output = '') {
  const lines = String(output).split(/\r?\n/);
  const formatted = [];
  lines.forEach((line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && !Array.isArray(event)) {
        const summary = summarizeCodexEvent(event);
        if (summary) formatted.push(summary);
        return;
      }
    } catch {
      // stdout may include wrapper text; stderr is displayed separately as raw text.
    }
    formatted.push(line);
  });
  return formatted.join('\n');
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
  const promptCount = root.querySelector('[data-prompt-count]');
  if (promptCount) promptCount.textContent = `${snapshot.steps.length} ${snapshot.steps.length === 1 ? 'prompt' : 'prompts'}`;
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
  const progress = root.querySelector('[data-run-progress]');
  if (progress) {
    progress.setAttribute('aria-valuenow', snapshot.progress);
    progress.setAttribute('aria-label', 'Run progress');
    progress.dataset.progressState = snapshot.status === 'running' ? 'running' : 'idle';
    const description = progress.querySelector('[data-run-progress-description]');
    if (description) description.textContent = snapshot.status === 'running' ? 'Run in progress' : `Run ${snapshot.status}`;
  }
  const caption = root.querySelector('[data-run-progress-caption]');
  if (caption) caption.textContent = snapshot.status === 'running' ? 'Codex is cooking your recipe…' : `Run status: ${snapshot.status}.`;
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
  const stdout = root.querySelector('[data-run-stdout]');
  if (stdout) {
    stdout.textContent = formatCodexStream(snapshot.stdout) || 'Waiting for Codex stream…';
    const terminal = root.querySelector('[data-run-terminal="stdout"]');
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }
  const stderr = root.querySelector('[data-run-stderr]');
  if (stderr) {
    stderr.textContent = snapshot.stderr || 'No stderr output.';
    const terminal = root.querySelector('[data-run-terminal="stderr"]');
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
  if (connection) connection.textContent = 'Connecting';
  source.addEventListener('open', () => {
    if (connection) connection.textContent = 'Live';
  });
  source.addEventListener('run-update', (event) => {
    if (connection) connection.textContent = 'Live';
    updateRunDetail(root, JSON.parse(event.data));
  });
  source.onerror = () => {
    if (connection) connection.textContent = 'Reconnecting';
  };
});

document.querySelectorAll('[data-run-stdout]').forEach((stdout) => {
  stdout.textContent = formatCodexStream(stdout.textContent) || 'Waiting for Codex stream…';
});

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function addButtonDelight() {
  document.querySelectorAll('.btn').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      if (prefersReducedMotion()) return;
      const rect = button.getBoundingClientRect();
      const ripple = document.createElement('span');
      const size = Math.max(rect.width, rect.height);
      ripple.className = 'chef-ripple';
      ripple.style.width = `${size}px`;
      ripple.style.height = `${size}px`;
      ripple.style.left = `${event.clientX - rect.left}px`;
      ripple.style.top = `${event.clientY - rect.top}px`;
      button.append(ripple);
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    });

    button.addEventListener('click', (event) => {
      if (prefersReducedMotion()) return;
      const glyphs = ['✦', '✧', '•', '✨'];
      for (let i = 0; i < 7; i += 1) {
        const burst = document.createElement('span');
        const angle = (Math.PI * 2 * i) / 7;
        const distance = 28 + Math.random() * 16;
        burst.className = 'chef-burst';
        burst.textContent = glyphs[i % glyphs.length];
        burst.style.left = `${event.clientX}px`;
        burst.style.top = `${event.clientY}px`;
        burst.style.setProperty('--burst-x', `${Math.cos(angle) * distance}px`);
        burst.style.setProperty('--burst-y', `${Math.sin(angle) * distance}px`);
        document.body.append(burst);
        burst.addEventListener('animationend', () => burst.remove(), { once: true });
      }
    });
  });
}

function addRecipeCardTilt() {
  document.querySelectorAll('.recipe-card').forEach((card, index) => {
    card.style.setProperty('--idle-rotate', `${(index % 3) - 1}deg`);
    card.addEventListener('pointermove', (event) => {
      if (prefersReducedMotion() || event.pointerType === 'touch') return;
      const rect = card.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      card.classList.add('is-tilting');
      card.style.transform = `perspective(900px) rotateX(${y * -5}deg) rotateY(${x * 7}deg) translateY(-7px)`;
      card.style.boxShadow = `${10 + x * 10}px ${14 + y * 10}px 28px rgba(57,43,36,.24)`;
    });
    card.addEventListener('pointerleave', () => {
      card.classList.remove('is-tilting');
      card.style.transform = '';
      card.style.boxShadow = '';
    });
    card.addEventListener('pointerdown', () => card.classList.add('is-selected'));
    card.addEventListener('pointerup', () => setTimeout(() => card.classList.remove('is-selected'), 420));
  });
}

function pauseOffscreenAnimations() {
  if (!('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      entry.target.style.animationPlayState = entry.isIntersecting ? 'running' : 'paused';
      entry.target.querySelectorAll('*').forEach((child) => { child.style.animationPlayState = entry.isIntersecting ? 'running' : 'paused'; });
    });
  }, { rootMargin: '120px' });
  document.querySelectorAll('.recipe-card, .stat-card, .chef-loader, .timeline-item, .paper-panel').forEach((element) => observer.observe(element));
}

function animateNavigation() {
  if (prefersReducedMotion()) return;
  document.body.animate([
    { opacity: 0, transform: 'translateY(10px) scale(.992)' },
    { opacity: 1, transform: 'translateY(0) scale(1)' }
  ], { duration: 420, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'both' });
}

addButtonDelight();
addRecipeCardTilt();
pauseOffscreenAnimations();
animateNavigation();

// Reusable animation utility system for cinematic cookbook UX.
const ChefMotion = (() => {
  const reduced = () => prefersReducedMotion();
  function stagger(root = document) {
    root.querySelectorAll('.motion-stagger, .row, .timeline, .prompt-chain, .recipe-grid').forEach((group) => {
      Array.from(group.children).forEach((child, index) => child.style.setProperty('--stagger-index', index));
    });
  }
  function revealSections() {
    const targets = document.querySelectorAll('section, .paper-panel, .recipe-card, .stat-card, .empty-state');
    if (!('IntersectionObserver' in window) || reduced()) {
      targets.forEach((target) => target.classList.add('motion-in-view'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('motion-in-view');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    targets.forEach((target) => observer.observe(target));
  }
  function sparkle(x, y, count = 10) {
    if (reduced()) return;
    for (let index = 0; index < count; index += 1) {
      const star = document.createElement('span');
      star.className = 'chef-sparkle';
      star.textContent = ['✦', '✨', '✧', '⋆'][index % 4];
      star.style.left = `${x + (Math.random() - 0.5) * 80}px`;
      star.style.top = `${y + (Math.random() - 0.5) * 60}px`;
      document.body.append(star);
      star.addEventListener('animationend', () => star.remove(), { once: true });
    }
  }
  function confetti(count = 42) {
    if (reduced()) return;
    const colors = ['#ee6352', '#ffd95a', '#6bcb77', '#4d96ff', '#7c5cff'];
    for (let index = 0; index < count; index += 1) {
      const bit = document.createElement('span');
      bit.className = 'chef-confetti';
      bit.style.background = colors[index % colors.length];
      bit.style.height = `${6 + Math.random() * 9}px`;
      bit.style.left = `${Math.random() * 100}vw`;
      bit.style.top = `${-10 - Math.random() * 30}px`;
      bit.style.width = `${5 + Math.random() * 7}px`;
      bit.style.animationDelay = `${Math.random() * .35}s`;
      document.body.append(bit);
      bit.addEventListener('animationend', () => bit.remove(), { once: true });
    }
  }
  function fireworks(count = 8) {
    if (reduced()) return;
    for (let index = 0; index < count; index += 1) {
      const firework = document.createElement('span');
      firework.className = 'chef-firework';
      firework.textContent = '🎆';
      firework.style.left = `${10 + Math.random() * 80}vw`;
      firework.style.top = `${8 + Math.random() * 45}vh`;
      firework.style.animationDelay = `${index * 90}ms`;
      document.body.append(firework);
      firework.addEventListener('animationend', () => firework.remove(), { once: true });
    }
  }
  function stamp(element, label = 'COMPLETE') {
    if (!element || reduced()) return;
    const badge = document.createElement('span');
    badge.className = 'status-badge motion-stamp position-absolute top-0 end-0 m-3';
    badge.textContent = label;
    element.style.position = 'relative';
    element.append(badge);
    setTimeout(() => badge.remove(), 2600);
  }
  return { stagger, revealSections, sparkle, confetti, fireworks, stamp };
})();

function setupMascot() {
  const mascot = document.querySelector('[data-chef-mascot]');
  if (!mascot) return;
  const message = mascot.querySelector('[data-chef-message]');
  const hat = mascot.querySelector('[data-chef-hat]');
  const status = document.querySelector('[data-run-status], .status-badge[data-status]')?.dataset.status || '';
  const mood = status.includes('succeeded') ? 'success' : status.includes('failed') ? 'failed' : status.includes('waiting') || status.includes('queued') ? 'waiting' : status.includes('running') ? 'running' : 'idle';
  const copy = { idle: 'Need a recipe?', running: 'Stirring Codex…', success: 'Bon appétit!', failed: 'Too smoky!', waiting: 'Cooldown nap…' };
  mascot.dataset.mood = mood;
  if (message) message.textContent = copy[mood];
  let hatClicks = 0;
  if (hat) hat.addEventListener('click', () => {
    hatClicks += 1;
    ChefMotion.sparkle(window.innerWidth - 80, window.innerHeight - 120, 8);
    if (hatClicks >= 10) { ChefMotion.confetti(80); hatClicks = 0; }
  });
}

function setupEasterEggs() {
  const konami = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
  const keys = [];
  document.addEventListener('keydown', (event) => {
    keys.push(event.key);
    keys.splice(0, Math.max(0, keys.length - konami.length));
    if (konami.every((key, index) => key === keys[index])) {
      document.body.classList.add('master-chef-mode');
      ChefMotion.confetti(120); ChefMotion.fireworks(10);
      setTimeout(() => document.body.classList.remove('master-chef-mode'), 4200);
    }
  });
  if (Math.random() < 0.08 && !prefersReducedMotion()) {
    setTimeout(() => {
      const spatula = document.createElement('span');
      spatula.className = 'golden-spatula'; spatula.textContent = '🏆🥄';
      spatula.style.left = '70vw'; spatula.style.top = '82vh'; document.body.append(spatula);
      spatula.addEventListener('animationend', () => spatula.remove(), { once: true });
    }, 1800);
  }
  document.addEventListener('pointermove', (event) => {
    if (prefersReducedMotion() || Math.random() > 0.002) return;
    const mouse = document.createElement('span');
    mouse.className = 'tiny-mouse'; mouse.textContent = '🐭';
    mouse.style.left = `${event.clientX}px`; mouse.style.top = `${event.clientY + 12}px`; document.body.append(mouse);
    mouse.addEventListener('animationend', () => mouse.remove(), { once: true });
  });
}

function celebrateExistingSuccess() {
  if (document.querySelector('[data-run-status]')?.textContent.trim() === 'succeeded') {
    ChefMotion.stamp(document.querySelector('.recipe-page'), 'COMPLETE');
    ChefMotion.fireworks(6);
  }
}

ChefMotion.stagger();
ChefMotion.revealSections();
setupMascot();
setupEasterEggs();
celebrateExistingSuccess();
