const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const builtInRecipeTemplates = require('./services/builtInRecipeTemplates');

const defaultDatabasePath = path.join(process.cwd(), 'data', 'mvp-chef-codex.sqlite');
const databasePath = process.env.DATABASE_PATH || defaultDatabasePath;

function ensureDatabaseDirectory(filePath) {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function tableExists(db, tableName) {
  const table = db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?').get(tableName);
  return Boolean(table);
}

function tableHasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((column) => column.name === columnName);
}

function prepareLegacyRecipeTable(db) {
  if (tableExists(db, 'recipes') && !tableHasColumn(db, 'recipes', 'name')) {
    db.exec('ALTER TABLE recipes RENAME TO legacy_recipes');
  }
}

function runMigrations(db) {
  prepareLegacyRecipeTable(db);

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrations = [
    {
      version: 1,
      name: 'create_mvp_chef_codex_schema',
      sql: `
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          github_repo_url TEXT,
          description TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS recipes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER,
          name TEXT NOT NULL,
          version TEXT NOT NULL DEFAULT '1.0.0',
          description TEXT NOT NULL,
          imported_json TEXT,
          exported_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS recipe_steps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recipe_id INTEGER NOT NULL,
          step_order INTEGER NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
          UNIQUE (recipe_id, step_order)
        );

        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER,
          recipe_id INTEGER,
          status TEXT NOT NULL DEFAULT 'queued',
          stdout_log TEXT,
          stderr_log TEXT,
          commit_sha TEXT,
          pr_url TEXT,
          error_message TEXT,
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
          FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS run_steps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL,
          recipe_step_id INTEGER,
          step_order INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          stdout_log TEXT,
          stderr_log TEXT,
          commit_sha TEXT,
          error_message TEXT,
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
          FOREIGN KEY (recipe_step_id) REFERENCES recipe_steps(id) ON DELETE SET NULL,
          UNIQUE (run_id, step_order)
        );

        CREATE TABLE IF NOT EXISTS app_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL UNIQUE,
          value TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_projects_repo_path ON projects(repo_path);
        CREATE INDEX IF NOT EXISTS idx_recipes_project_id ON recipes(project_id);
        CREATE INDEX IF NOT EXISTS idx_recipe_steps_recipe_id ON recipe_steps(recipe_id);
        CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
        CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON run_steps(run_id);
      `
    },
    {
      version: 2,
      name: 'add_recipe_step_crud_fields',
      sql: `
        ALTER TABLE recipe_steps ADD COLUMN required_checks TEXT NOT NULL DEFAULT '';
        ALTER TABLE recipe_steps ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE recipe_steps ADD COLUMN human_approval INTEGER NOT NULL DEFAULT 0;
      `
    },
    {
      version: 3,
      name: 'add_project_management_fields',
      sql: `
        ALTER TABLE projects ADD COLUMN github_repo_slug TEXT NOT NULL DEFAULT '';
        ALTER TABLE projects ADD COLUMN default_branch TEXT NOT NULL DEFAULT 'main';
        ALTER TABLE projects ADD COLUMN package_manager_command TEXT NOT NULL DEFAULT 'npm install';
        ALTER TABLE projects ADD COLUMN test_command TEXT NOT NULL DEFAULT 'npm test';
        ALTER TABLE projects ADD COLUMN build_command TEXT NOT NULL DEFAULT 'npm run build';
        ALTER TABLE projects ADD COLUMN lint_command TEXT NOT NULL DEFAULT 'npm run lint';
        UPDATE projects
        SET github_repo_slug = CASE
          WHEN github_repo_url LIKE 'https://github.com/%' THEN substr(github_repo_url, length('https://github.com/') + 1)
          ELSE github_repo_slug
        END
        WHERE github_repo_slug = '';
        CREATE INDEX IF NOT EXISTS idx_projects_github_repo_slug ON projects(github_repo_slug);
      `
    },
    {
      version: 4,
      name: 'normalize_run_statuses',
      sql: `
        UPDATE runs SET status = 'pending' WHERE status = 'queued';
        UPDATE runs SET status = 'succeeded' WHERE status = 'completed';
        UPDATE run_steps SET status = 'pending' WHERE status = 'queued';
        UPDATE run_steps SET status = 'succeeded' WHERE status = 'completed';
        CREATE INDEX IF NOT EXISTS idx_runs_project_status ON runs(project_id, status);
      `
    },
    {
      version: 5,
      name: 'add_run_step_quality_gates',
      sql: `
        ALTER TABLE run_steps ADD COLUMN quality_gate_override INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE run_steps ADD COLUMN quality_gate_override_reason TEXT;
        ALTER TABLE run_steps ADD COLUMN quality_gate_override_at TEXT;

        CREATE TABLE IF NOT EXISTS run_step_checks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL,
          run_step_id INTEGER NOT NULL,
          check_name TEXT NOT NULL,
          command TEXT NOT NULL,
          required INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          exit_code INTEGER,
          stdout_log TEXT,
          stderr_log TEXT,
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
          FOREIGN KEY (run_step_id) REFERENCES run_steps(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_run_step_checks_run_id ON run_step_checks(run_id);
        CREATE INDEX IF NOT EXISTS idx_run_step_checks_step_id ON run_step_checks(run_step_id);
      `
    },
    {
      version: 6,
      name: 'add_run_step_github_automation_fields',
      sql: `
        ALTER TABLE run_steps ADD COLUMN pr_url TEXT;
        ALTER TABLE run_steps ADD COLUMN merge_commit_sha TEXT;
      `
    },
    {
      version: 7,
      name: 'add_quota_cooldown_fields',
      sql: `
        ALTER TABLE runs ADD COLUMN quota_refill_at TEXT;
        ALTER TABLE runs ADD COLUMN quota_retry_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE run_steps ADD COLUMN quota_refill_at TEXT;
        ALTER TABLE run_steps ADD COLUMN quota_retry_count INTEGER NOT NULL DEFAULT 0;
      `
    },
    {
      version: 8,
      name: 'add_human_approval_controls',
      sql: `
        ALTER TABLE recipes ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'manual_steps';
        ALTER TABLE recipe_steps ADD COLUMN approval_override TEXT NOT NULL DEFAULT 'inherit';
        ALTER TABLE projects ADD COLUMN safe_mode INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE run_steps ADD COLUMN approval_point TEXT;
        ALTER TABLE run_steps ADD COLUMN prompt_override TEXT;
        ALTER TABLE run_steps ADD COLUMN skipped_at TEXT;
      `
    },
    {
      version: 9,
      name: 'add_failure_recovery_actions',
      sql: `
        CREATE TABLE IF NOT EXISTS run_recovery_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL,
          run_step_id INTEGER,
          action TEXT NOT NULL,
          details_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
          FOREIGN KEY (run_step_id) REFERENCES run_steps(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_recovery_actions_run_id ON run_recovery_actions(run_id);
      `
    }
  ];

  const applied = db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version);
  const insertMigration = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');

  migrations.forEach((migration) => {
    if (!applied.includes(migration.version)) {
      const applyMigration = db.transaction(() => {
        db.exec(migration.sql);
        insertMigration.run(migration.version, migration.name);
      });
      applyMigration();
    }
  });
}

function migrateLegacyRecipes(db) {
  if (!tableExists(db, 'legacy_recipes')) {
    return;
  }

  const legacyRecipes = db.prepare('SELECT * FROM legacy_recipes ORDER BY id ASC').all();
  const existingCount = db.prepare('SELECT COUNT(*) AS total FROM recipes').get().total;

  if (existingCount > 0 || legacyRecipes.length === 0) {
    return;
  }

  const insertRecipe = db.prepare(`
    INSERT INTO recipes (name, version, description, imported_json, exported_json, created_at)
    VALUES (@name, @version, @description, @importedJson, @exportedJson, @createdAt)
  `);
  const insertStep = db.prepare(`
    INSERT INTO recipe_steps (recipe_id, step_order, title, prompt)
    VALUES (@recipeId, @stepOrder, @title, @prompt)
  `);

  const migrate = db.transaction(() => {
    legacyRecipes.forEach((legacyRecipe) => {
      const ingredients = legacyRecipe.ingredients.split('\n').map((line) => line.trim()).filter(Boolean);
      const steps = legacyRecipe.instructions.split('\n').map((prompt, index) => ({
        title: `Step ${index + 1}`,
        prompt: prompt.trim()
      })).filter((step) => step.prompt);
      const recipeJson = {
        name: legacyRecipe.title,
        version: legacyRecipe.phase,
        description: legacyRecipe.summary,
        ingredients,
        steps
      };
      const result = insertRecipe.run({
        name: recipeJson.name,
        version: recipeJson.version,
        description: recipeJson.description,
        importedJson: JSON.stringify(recipeJson, null, 2),
        exportedJson: JSON.stringify(recipeJson, null, 2),
        createdAt: legacyRecipe.created_at
      });

      steps.forEach((step, index) => {
        insertStep.run({
          recipeId: result.lastInsertRowid,
          stepOrder: index + 1,
          title: step.title,
          prompt: step.prompt
        });
      });
    });
  });

  migrate();
}


function seedBuiltInRecipeTemplates(db, projectId = null) {
  const insertRecipe = db.prepare(`
    INSERT INTO recipes (project_id, name, version, description, imported_json, exported_json)
    VALUES (@projectId, @name, @version, @description, @recipeJson, @recipeJson)
  `);
  const insertStep = db.prepare(`
    INSERT INTO recipe_steps (recipe_id, step_order, title, prompt, required_checks, retry_count, human_approval, approval_override)
    VALUES (@recipeId, @stepOrder, @title, @prompt, @requiredChecks, @retryCount, @humanApproval, 'inherit')
  `);
  const existingRecipe = db.prepare('SELECT id FROM recipes WHERE name = ? LIMIT 1');

  const seedTemplates = db.transaction(() => {
    builtInRecipeTemplates.forEach((template) => {
      if (existingRecipe.get(template.name)) {
        return;
      }

      const recipeJson = JSON.stringify(template, null, 2);
      const recipe = insertRecipe.run({
        projectId,
        name: template.name,
        version: template.version,
        description: template.description,
        recipeJson
      });

      template.steps.forEach((step, index) => {
        insertStep.run({
          recipeId: recipe.lastInsertRowid,
          stepOrder: index + 1,
          title: step.title,
          prompt: step.prompt,
          requiredChecks: (step.requiredChecks || []).join('\n'),
          retryCount: step.maxRetries || 0,
          humanApproval: step.requiresApproval ? 1 : 0
        });
      });
    });
  });

  seedTemplates();
}

function seedDatabase(db) {
  migrateLegacyRecipes(db);

  const insertSetting = db.prepare(`
    INSERT INTO app_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  insertSetting.run('autoMergeEnabled', 'true');
  insertSetting.run('requireHumanApprovalBeforeMerge', 'false');
  insertSetting.run('protectedMainMode', 'true');
    insertSetting.run('projectSafeModeDefault', 'false');
  insertSetting.run('projectSafeModeDefault', 'false');

  const projectCount = db.prepare('SELECT COUNT(*) AS total FROM projects').get().total;

  if (projectCount > 0) {
    seedBuiltInRecipeTemplates(db);
    return;
  }

  const seed = db.transaction(() => {
    const project = db.prepare(`
      INSERT INTO projects (
        name, repo_path, github_repo_url, github_repo_slug, default_branch,
        package_manager_command, test_command, build_command, lint_command, description
      )
      VALUES (
        @name, @repoPath, @githubRepoUrl, @githubRepoSlug, @defaultBranch,
        @packageManagerCommand, @testCommand, @buildCommand, @lintCommand, @description
      )
    `).run({
      name: 'Demo MVP Chef Project',
      repoPath: process.cwd(),
      githubRepoUrl: 'https://github.com/example/demo-mvp-chef-project',
      githubRepoSlug: 'example/demo-mvp-chef-project',
      defaultBranch: 'main',
      packageManagerCommand: 'npm install',
      testCommand: 'npm test',
      buildCommand: 'npm run build',
      lintCommand: 'npm run lint',
      description: 'A sample project for trying recipe-driven Codex runs.'
    });

    const recipeJson = {
      name: 'Product Brief Soufflé',
      version: '1.0.0',
      description: 'Turn a fuzzy product idea into a light, structured MVP brief.',
      ingredients: [
        'Target user',
        'Core problem',
        'Primary journey',
        'Must-have features',
        'Success metrics'
      ],
      steps: [
        {
          title: 'Clarify the appetite',
          prompt: 'Ask up to five clarifying questions about users, the problem, constraints, and success criteria.'
        },
        {
          title: 'Plate the brief',
          prompt: 'Draft a concise MVP product brief with goals, non-goals, feature boundaries, and measurable success signals.'
        }
      ]
    };

    const recipe = db.prepare(`
      INSERT INTO recipes (project_id, name, version, description, imported_json, exported_json)
      VALUES (@projectId, @name, @version, @description, @importedJson, @exportedJson)
    `).run({
      projectId: project.lastInsertRowid,
      name: recipeJson.name,
      version: recipeJson.version,
      description: recipeJson.description,
      importedJson: JSON.stringify(recipeJson, null, 2),
      exportedJson: JSON.stringify(recipeJson, null, 2)
    });

    const insertStep = db.prepare(`
      INSERT INTO recipe_steps (recipe_id, step_order, title, prompt)
      VALUES (@recipeId, @stepOrder, @title, @prompt)
    `);

    recipeJson.steps.forEach((step, index) => {
      insertStep.run({
        recipeId: recipe.lastInsertRowid,
        stepOrder: index + 1,
        title: step.title,
        prompt: step.prompt
      });
    });

    seedBuiltInRecipeTemplates(db, project.lastInsertRowid);

    db.prepare(`
      INSERT INTO app_settings (key, value)
      VALUES ('seeded_at', CURRENT_TIMESTAMP)
    `).run();

    const insertSetting = db.prepare(`
      INSERT INTO app_settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO NOTHING
    `);
    insertSetting.run('autoMergeEnabled', 'true');
    insertSetting.run('requireHumanApprovalBeforeMerge', 'false');
    insertSetting.run('protectedMainMode', 'true');
  });

  seed();
}

ensureDatabaseDirectory(databasePath);

const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

runMigrations(db);
seedDatabase(db);

module.exports = db;
