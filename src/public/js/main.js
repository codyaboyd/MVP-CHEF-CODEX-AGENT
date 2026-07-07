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
