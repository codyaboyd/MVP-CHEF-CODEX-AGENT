const { execFile } = require('node:child_process');
const fs = require('node:fs');

const DEFAULT_MAIN_BRANCH = 'main';

function runGit(repoPath, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repoPath, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      const result = { stdout: stdout.trim(), stderr: stderr.trim(), args };
      if (error) {
        const gitError = new Error(result.stderr || result.stdout || error.message);
        gitError.code = error.code;
        gitError.result = result;
        gitError.isMergeConflict = /conflict|CONFLICT|Automatic merge failed|unmerged/i.test(`${result.stdout}\n${result.stderr}`);
        if (options.allowFailure) return resolve({ ...result, error: gitError });
        return reject(gitError);
      }
      return resolve(result);
    });
  });
}

function validateRepoPath(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new Error('A valid git repository path is required.');
  }
}

function slugify(value) {
  return String(value || 'step')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'step';
}

function parsePorcelain(output) {
  return output.split('\n').filter(Boolean).map((line) => ({
    status: line.slice(0, 2).trim(),
    file: line.slice(3).trim()
  }));
}

class GitManager {
  constructor({ repoPath, mainBranch = DEFAULT_MAIN_BRANCH } = {}) {
    validateRepoPath(repoPath);
    this.repoPath = repoPath;
    this.mainBranch = mainBranch || DEFAULT_MAIN_BRANCH;
  }

  async ensureGitRepository() {
    await runGit(this.repoPath, ['rev-parse', '--is-inside-work-tree']);
    return true;
  }

  async getCurrentSha() {
    const result = await runGit(this.repoPath, ['rev-parse', 'HEAD']);
    return result.stdout;
  }

  async assertCleanWorkingTree() {
    await this.ensureGitRepository();
    const result = await runGit(this.repoPath, ['status', '--porcelain']);
    if (result.stdout) {
      const files = parsePorcelain(result.stdout).map((entry) => `${entry.status} ${entry.file}`).join('\n');
      throw new Error(`Working tree must be clean before running Codex. Dirty files:\n${files}`);
    }
    return true;
  }

  branchNameForStep({ runId, stepId, stepTitle }) {
    return `mvp-chef/run-${runId}/step-${stepId}-${slugify(stepTitle)}`;
  }

  async createBranchForStep({ runId, stepId, stepTitle }) {
    await this.assertCleanWorkingTree();
    const branchName = this.branchNameForStep({ runId, stepId, stepTitle });
    await runGit(this.repoPath, ['checkout', '-B', branchName]);
    return branchName;
  }

  async detectChangedFiles() {
    const result = await runGit(this.repoPath, ['status', '--porcelain']);
    return parsePorcelain(result.stdout);
  }

  async diffSummary() {
    const status = await runGit(this.repoPath, ['status', '--short']);
    const stat = await runGit(this.repoPath, ['diff', '--stat']);
    const staged = await runGit(this.repoPath, ['diff', '--cached', '--stat']);
    return [status.stdout, stat.stdout, staged.stdout].filter(Boolean).join('\n');
  }

  async commitStep({ runId, stepId, stepTitle }) {
    const changedFiles = await this.detectChangedFiles();
    const summary = await this.diffSummary();
    if (changedFiles.length === 0) {
      return { committed: false, changedFiles, diffSummary: summary, commitSha: null };
    }

    await runGit(this.repoPath, ['add', '--all']);
    const message = `mvp-chef: ${stepTitle || `step ${stepId}`}`;
    const body = `Run ID: ${runId}\nStep ID: ${stepId}`;
    await runGit(this.repoPath, ['commit', '-m', message, '-m', body]);
    const commitSha = await this.getCurrentSha();
    return { committed: true, changedFiles, diffSummary: summary, commitSha };
  }

  async pushBranch(branchName) {
    const branch = branchName || (await runGit(this.repoPath, ['branch', '--show-current'])).stdout;
    await runGit(this.repoPath, ['push', '-u', 'origin', branch]);
    return branch;
  }

  async pullLatestMain() {
    await this.assertCleanWorkingTree();
    await runGit(this.repoPath, ['checkout', this.mainBranch]);
    const result = await runGit(this.repoPath, ['pull', '--ff-only', 'origin', this.mainBranch], { allowFailure: true });
    if (result.error) {
      throw this.decorateConflictError(result.error, 'Unable to pull the latest main branch.');
    }
    return result.stdout;
  }

  async rollbackToCheckpoint(checkpointSha) {
    if (!checkpointSha) throw new Error('A checkpoint commit SHA is required for rollback.');
    await runGit(this.repoPath, ['reset', '--hard', checkpointSha]);
    await runGit(this.repoPath, ['clean', '-fd']);
    return checkpointSha;
  }

  decorateConflictError(error, prefix = 'Git operation failed.') {
    if (error.isMergeConflict) {
      error.message = `${prefix} Merge conflicts were detected. Resolve conflicts in the repository, commit or abort the merge, then retry.\n${error.message}`;
    }
    return error;
  }
}

module.exports = {
  GitManager,
  runGit
};
