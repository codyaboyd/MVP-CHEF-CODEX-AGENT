# MVP Chef: Codex Prompt Recipe Lists

MVP Chef is a lightweight prompt cookbook for building minimum viable products with Codex. It organizes repeatable, copy-ready prompt recipes into practical build phases so you can move from idea to shipped prototype with less guesswork.

## What this repository is for

Use this repository as a starting point when you want Codex to help plan, scaffold, implement, test, and polish an MVP. Instead of writing one large vague prompt, work through focused recipes that define the desired outcome, useful context, constraints, and acceptance criteria.

## How to use the recipes

1. Pick the phase that matches your current need.
2. Copy the prompt recipe into Codex.
3. Replace bracketed placeholders with your product details.
4. Review Codex's plan before implementation.
5. Run the suggested checks, then iterate with the follow-up prompts.

## Prompt recipe list

### 1. Product brief

```text
You are helping me define an MVP. Create a concise product brief for [PRODUCT IDEA].
Include:
- target user
- core problem
- primary user journey
- must-have features
- out-of-scope features
- success metrics
Ask up to 5 clarifying questions before drafting if needed.
```

### 2. MVP scope cutter

```text
Given this product brief: [PASTE BRIEF]
Reduce it to the smallest useful MVP that can be built in [TIMEBOX].
Return:
- features to keep
- features to cut
- assumptions
- risks
- a milestone plan
```

### 3. Technical plan

```text
Create an implementation plan for this MVP: [PASTE MVP SCOPE].
Use this stack if possible: [STACK].
Include:
- architecture overview
- data model
- routes or screens
- integrations
- test strategy
- step-by-step implementation tasks
Do not write code yet.
```

### 4. Repository scaffold

```text
Scaffold the MVP from this technical plan: [PASTE PLAN].
Follow the existing repository conventions.
Create the minimum files needed for a runnable first version.
After changes, summarize files changed and commands to run.
```

### 5. Feature implementation

```text
Implement this feature: [FEATURE].
Context:
- product goal: [GOAL]
- relevant files: [FILES]
- acceptance criteria: [CRITERIA]
Keep the change focused. Add or update tests where appropriate.
```

### 6. UI polish pass

```text
Improve the user experience for this screen or flow: [SCREEN/FLOW].
Prioritize clarity, empty states, loading states, accessible labels, and responsive layout.
Keep the visual style consistent with the current app.
```

### 7. Test and bug-fix loop

```text
Run the relevant checks for this project, inspect failures, and fix only the issues caused by the current change.
Report:
- commands run
- failures found
- fixes made
- any remaining limitations
```

### 8. Launch readiness review

```text
Review this MVP for launch readiness.
Check:
- critical user paths
- configuration and environment variables
- error states
- security basics
- analytics or success tracking
- README/setup instructions
Return a prioritized checklist of blockers and nice-to-haves.
```

## Recommended workflow

```text
Product brief -> Scope cutter -> Technical plan -> Scaffold -> Feature loops -> Test loop -> Launch review
```

Keep each prompt small and specific. Codex performs best when it has the repository context, a clear target, and concrete acceptance criteria.

## Tips for better Codex sessions

- Start by asking for a plan before requesting code.
- Name the files, routes, screens, or modules that matter.
- Include examples of expected inputs and outputs.
- Ask Codex to keep changes focused and avoid unrelated refactors.
- Run tests or checks after each meaningful change.
- Commit working increments so you can safely iterate.

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.
