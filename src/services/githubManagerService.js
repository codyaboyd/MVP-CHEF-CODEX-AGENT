const { execFile } = require('node:child_process');
const fs = require('node:fs');

const DEFAULT_MAIN_BRANCH = 'main';
const DEFAULT_CHECK_POLL_INTERVAL_MS = 5000;
const DEFAULT_CHECK_TIMEOUT_MS = 20 * 60 * 1000;

function validateRepoPath(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new Error('A valid git repository path is required.');
  }
}

function runGh(repoPath, args, options = {}) {
  const command = options.ghCommand || 'gh';
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: repoPath, maxBuffer: 1024 * 1024 * 10, timeout: options.timeoutMs || 0 }, (error, stdout, stderr) => {
      const result = { stdout: stdout.trim(), stderr: stderr.trim(), args };
      if (error) {
        const ghError = new Error(result.stderr || result.stdout || error.message);
        ghError.code = error.code;
        ghError.result = result;
        ghError.isMissingCli = error.code === 'ENOENT';
        if (options.allowFailure) return resolve({ ...result, error: ghError });
        return reject(ghError);
      }
      return resolve(result);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMergeCommitSha(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed.mergeCommit?.oid || parsed.mergeCommitSha || null;
  } catch {
    return null;
  }
}

class GitHubManager {
  constructor({ repoPath, mainBranch = DEFAULT_MAIN_BRANCH, ghCommand = 'gh', checkPollIntervalMs = DEFAULT_CHECK_POLL_INTERVAL_MS, checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS } = {}) {
    validateRepoPath(repoPath);
    this.repoPath = repoPath;
    this.mainBranch = mainBranch || DEFAULT_MAIN_BRANCH;
    this.ghCommand = ghCommand || 'gh';
    this.checkPollIntervalMs = checkPollIntervalMs;
    this.checkTimeoutMs = checkTimeoutMs;
  }

  async run(args, options = {}) {
    return runGh(this.repoPath, args, { ...options, ghCommand: this.ghCommand });
  }

  async verifyCli() {
    const version = await this.run(['--version'], { allowFailure: true });
    if (version.error) {
      if (version.error.isMissingCli) {
        const error = new Error('GitHub CLI (gh) is not installed. Install gh and run `gh auth login`, then retry GitHub automation.');
        error.code = 'GH_CLI_MISSING';
        throw error;
      }
      throw version.error;
    }
    const auth = await this.run(['auth', 'status'], { allowFailure: true });
    if (auth.error) {
      const error = new Error(`GitHub CLI is not authenticated. Run \`gh auth login\`, then retry GitHub automation.\n${auth.error.message}`);
      error.code = 'GH_AUTH_REQUIRED';
      throw error;
    }
    return { version: version.stdout, authenticated: true };
  }

  async createPullRequest({ branchName, title, body }) {
    await this.verifyCli();
    const args = [
      'pr', 'create',
      '--base', this.mainBranch,
      '--head', branchName,
      '--title', title,
      '--body', body || '',
      '--json', 'url',
      '--jq', '.url'
    ];
    const result = await this.run(args);
    return result.stdout.split('\n').filter(Boolean).at(-1) || result.stdout;
  }

  async waitForChecks(prUrl, { timeoutMs = this.checkTimeoutMs, pollIntervalMs = this.checkPollIntervalMs } = {}) {
    const started = Date.now();
    while (true) {
      const remainingMs = Math.max(timeoutMs - (Date.now() - started), 1);
      const result = await this.run(['pr', 'checks', prUrl, '--watch', '--fail-fast', '--interval', '10'], { allowFailure: true, timeoutMs: remainingMs });
      if (!result.error) return true;
      if (Date.now() - started >= timeoutMs) {
        const error = new Error(`GitHub checks did not pass before timeout for ${prUrl}.\n${result.error.message}`);
        error.code = 'GH_CHECKS_TIMEOUT';
        throw error;
      }
      if (!/no checks|pending|in progress|queued/i.test(`${result.stdout}\n${result.stderr}\n${result.error.message}`)) {
        const error = new Error(`GitHub checks failed for ${prUrl}.\n${result.error.message}`);
        error.code = 'GH_CHECKS_FAILED';
        throw error;
      }
      await sleep(pollIntervalMs);
    }
  }

  async mergePullRequest(prUrl, { squash = true } = {}) {
    const args = ['pr', 'merge', prUrl, '--delete-branch'];
    args.push(squash ? '--squash' : '--merge');
    await this.run(args);
    const view = await this.run(['pr', 'view', prUrl, '--json', 'mergeCommit'], { allowFailure: true });
    return view.error ? null : parseMergeCommitSha(view.stdout);
  }

  async createMergeAfterChecks({ branchName, title, body, squash = true }) {
    const prUrl = await this.createPullRequest({ branchName, title, body });
    await this.waitForChecks(prUrl);
    const mergeCommitSha = await this.mergePullRequest(prUrl, { squash });
    return { prUrl, mergeCommitSha };
  }
}

module.exports = {
  GitHubManager,
  runGh
};
