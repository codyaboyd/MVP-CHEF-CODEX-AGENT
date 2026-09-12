const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPagination() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'js', 'main.js'), 'utf8');
  const start = source.indexOf('const RUN_PAGE_SIZE');
  const end = source.indexOf('function activityFromOutput');
  const context = {
    document: {
      createElement() {
        return {
          addEventListener(event, listener) { this.listeners ||= {}; this.listeners[event] = listener; }
        };
      }
    }
  };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.paginateRunOutput = paginateRunOutput;`, context);
  return context.paginateRunOutput;
}

test('live run pagination keeps an explicitly selected older page visible', () => {
  const paginateRunOutput = loadPagination();
  const nav = {
    replaceChildren() { this.children = []; },
    append(...children) { this.children = children; }
  };
  const root = { querySelector: () => nav };
  let visibleEntries;
  const render = (entries) => { visibleEntries = entries; };

  paginateRunOutput(root, 'visual', Array.from({ length: 250 }, (_, index) => index), render);
  assert.equal(visibleEntries[0], 200);

  nav.children[0].listeners.click();
  assert.equal(visibleEntries[0], 100);

  paginateRunOutput(root, 'visual', Array.from({ length: 251 }, (_, index) => index), render);
  assert.equal(visibleEntries[0], 100);

  nav.children[2].listeners.click();
  paginateRunOutput(root, 'visual', Array.from({ length: 301 }, (_, index) => index), render);
  assert.equal(visibleEntries[0], 300);
});
