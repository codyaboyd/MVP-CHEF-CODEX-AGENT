const builtInRecipeTemplates = [
  {
    name: 'Node.js SaaS MVP',
    version: '1.0.0',
    description: 'Build a production-minded Node.js SaaS starter with onboarding, billing hooks, tests, and deployment notes.',
    ingredients: ['Node.js 20+', 'Express or existing app framework', 'SQLite or project database', 'Bootstrap-compatible UI', 'Environment variables'],
    steps: [
      {
        title: 'Map the SaaS scope',
        prompt: 'Inspect the repository and write a concise implementation plan for a Node.js SaaS MVP. Identify the current framework, data layer, auth assumptions, billing assumptions, and the smallest valuable vertical slice. Do not edit files yet.',
        requiredChecks: ['Plan names affected routes, models, views, and tests'],
        maxRetries: 1,
        requiresApproval: false
      },
      {
        title: 'Create the tenant-ready foundation',
        prompt: 'Implement the SaaS foundation: account/workspace data structures, navigation entry points, empty states, and configuration loading. Keep changes incremental and compatible with the existing app style.',
        requiredChecks: ['npm test', 'npm run lint'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Add the first paid feature slice',
        prompt: 'Add one end-to-end feature that demonstrates SaaS value: persisted user/workspace data, create/read/update flow, validation, and a dashboard summary. Include useful fixtures or seeds when appropriate.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Harden launch readiness',
        prompt: 'Add launch-readiness polish: README setup notes, required environment variables, smoke-test instructions, and clear TODOs for production services that are intentionally stubbed.',
        requiredChecks: ['npm test', 'npm run build'],
        maxRetries: 1,
        requiresApproval: true
      }
    ]
  },
  {
    name: 'Bootstrap landing page',
    version: '1.0.0',
    description: 'Create a conversion-focused Bootstrap landing page that matches the app brand and ships with responsive sections.',
    ingredients: ['Bootstrap 5', 'Brand copy', 'Hero call to action', 'Feature proof points', 'Responsive QA'],
    steps: [
      {
        title: 'Audit the current frontend',
        prompt: 'Inspect the existing templates, CSS, and Bootstrap usage. Propose the landing-page sections, reusable classes, and any copy assumptions before editing.',
        requiredChecks: ['Plan references existing view and stylesheet files'],
        maxRetries: 1,
        requiresApproval: false
      },
      {
        title: 'Build the responsive page',
        prompt: 'Implement a polished Bootstrap landing page with hero, social proof or metrics, feature cards, workflow section, testimonial or trust block, FAQ, and a strong final CTA. Preserve existing navigation and app routes.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Tune visual details',
        prompt: 'Refine spacing, responsive behavior, accessible heading order, button labels, and color contrast. Avoid adding heavy dependencies.',
        requiredChecks: ['npm run lint', 'npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Capture verification notes',
        prompt: 'Document how to verify the landing page locally, including viewport sizes checked and any screenshots or limitations.',
        requiredChecks: ['npm run build'],
        maxRetries: 1,
        requiresApproval: true
      }
    ]
  },
  {
    name: 'REST API backend',
    version: '1.0.0',
    description: 'Add a documented REST API with validation, persistence, status codes, and integration tests.',
    ingredients: ['Express router', 'Service layer', 'Persistence model', 'Request validation', 'Supertest'],
    steps: [
      {
        title: 'Design the resource contract',
        prompt: 'Review existing routes and data access patterns, then design a REST resource contract with endpoints, request bodies, response shapes, validation errors, and status codes. Do not edit files yet.',
        requiredChecks: ['Contract includes list, detail, create, update, delete, and error cases'],
        maxRetries: 1,
        requiresApproval: false
      },
      {
        title: 'Implement API routes and services',
        prompt: 'Implement the REST API routes using the project\'s existing router/controller/service conventions. Add validation, consistent JSON errors, and safe database operations.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Add integration coverage',
        prompt: 'Add Supertest integration tests for successful CRUD operations, invalid input, missing resources, and response content types.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Document API usage',
        prompt: 'Update documentation with endpoint examples, curl snippets, setup requirements, and any authentication assumptions.',
        requiredChecks: ['npm run lint', 'npm test'],
        maxRetries: 1,
        requiresApproval: true
      }
    ]
  },
  {
    name: 'Auth system',
    version: '1.0.0',
    description: 'Introduce a pragmatic authentication flow with registration, login, logout, sessions, guards, and tests.',
    ingredients: ['User model', 'Password hashing', 'Session storage', 'Protected routes', 'Security tests'],
    steps: [
      {
        title: 'Choose the auth architecture',
        prompt: 'Inspect the app structure and propose the simplest secure auth architecture for this repository. Identify session storage, user fields, protected routes, password hashing approach, and migration needs. Do not edit files yet.',
        requiredChecks: ['Plan calls out security-sensitive files and dependencies'],
        maxRetries: 1,
        requiresApproval: true
      },
      {
        title: 'Implement credentials and sessions',
        prompt: 'Add registration, login, logout, password hashing, session persistence, flash or inline errors, and route guards. Keep secrets configurable through environment variables.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Protect user journeys',
        prompt: 'Apply auth guards to appropriate pages and APIs, add current-user navigation states, and ensure unauthenticated users are redirected safely without open redirects.',
        requiredChecks: ['npm run lint', 'npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Test auth abuse cases',
        prompt: 'Add tests for invalid credentials, duplicate registration, logout behavior, protected routes, session persistence, and password hash non-disclosure.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: false
      }
    ]
  },
  {
    name: 'Stripe billing',
    version: '1.0.0',
    description: 'Wire a Stripe-ready billing flow with checkout, customer portal, webhook handling, and safe local stubs.',
    ingredients: ['Stripe SDK or API client', 'Price IDs', 'Webhook secret', 'Account model', 'Billing tests'],
    steps: [
      {
        title: 'Plan billing boundaries',
        prompt: 'Review the app and design a Stripe billing integration plan. Identify plans/prices, customer mapping, subscription states, checkout route, portal route, webhook route, environment variables, and local-development stubs. Do not edit files yet.',
        requiredChecks: ['Plan lists all required Stripe environment variables'],
        maxRetries: 1,
        requiresApproval: true
      },
      {
        title: 'Add billing data model and config',
        prompt: 'Add billing-related fields or tables, configuration validation, and safe helpers for missing Stripe credentials in development. Never hard-code secrets.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Implement checkout and portal flows',
        prompt: 'Implement routes or controllers for creating checkout sessions and customer-portal sessions. Include clear user feedback when billing is not configured locally.',
        requiredChecks: ['npm run lint', 'npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Handle webhooks and docs',
        prompt: 'Add webhook signature verification, subscription state updates, tests with mocked Stripe payloads, and README instructions for local webhook forwarding.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: true
      }
    ]
  },
  {
    name: 'Admin dashboard',
    version: '1.0.0',
    description: 'Create an admin dashboard with operational metrics, management tables, filters, and safe actions.',
    ingredients: ['Admin route', 'Metrics queries', 'Management tables', 'Access control', 'Audit-friendly actions'],
    steps: [
      {
        title: 'Define admin needs',
        prompt: 'Inspect the app data model and propose an admin dashboard scope with metrics, tables, filters, actions, permissions, and empty states. Do not edit files yet.',
        requiredChecks: ['Plan identifies dashboard queries and guarded actions'],
        maxRetries: 1,
        requiresApproval: false
      },
      {
        title: 'Build dashboard metrics',
        prompt: 'Implement an admin dashboard page with high-signal metrics, recent activity, health indicators, and clear links to management areas.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Add management tables',
        prompt: 'Add searchable or filterable management tables with pagination-friendly structure, safe empty states, and non-destructive actions first.',
        requiredChecks: ['npm run lint', 'npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Secure and test admin flows',
        prompt: 'Add access-control checks or documented placeholders, tests for dashboard rendering and actions, and notes for future audit logging.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: true
      }
    ]
  },
  {
    name: 'CRUD app',
    version: '1.0.0',
    description: 'Ship a complete CRUD resource with forms, validation, persistence, list/detail views, and tests.',
    ingredients: ['Resource model', 'Controller routes', 'Form validation', 'List/detail views', 'CRUD tests'],
    steps: [
      {
        title: 'Select the resource slice',
        prompt: 'Inspect the product context and choose a single high-value CRUD resource. Define its fields, validation rules, routes, views, and database changes. Do not edit files yet.',
        requiredChecks: ['Plan includes create, read, update, delete, validation, and tests'],
        maxRetries: 1,
        requiresApproval: false
      },
      {
        title: 'Add persistence and service logic',
        prompt: 'Implement the database migration or schema update plus service-layer functions for listing, fetching, creating, updating, and deleting the resource safely.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Build routes and forms',
        prompt: 'Add controller routes and views for list, detail, new, edit, create, update, and delete flows. Include validation errors and success redirects that match existing UX conventions.',
        requiredChecks: ['npm run lint', 'npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Cover the CRUD lifecycle',
        prompt: 'Add integration tests that exercise the full CRUD lifecycle, invalid submissions, missing records, and cascade or cleanup behavior.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: false
      }
    ]
  },
  {
    name: 'AI chatbot app',
    version: '1.0.0',
    description: 'Build an AI chatbot experience with conversation state, provider abstraction, safe configuration, and tests.',
    ingredients: ['Chat UI', 'Conversation storage', 'AI provider key', 'Prompt guardrails', 'Mocked tests'],
    steps: [
      {
        title: 'Design the chat experience',
        prompt: 'Inspect the app and design the chatbot feature: target user job, conversation model, UI flow, provider abstraction, environment variables, safety constraints, and test strategy. Do not edit files yet.',
        requiredChecks: ['Plan separates provider integration from UI and persistence'],
        maxRetries: 1,
        requiresApproval: true
      },
      {
        title: 'Add conversation storage and UI',
        prompt: 'Implement conversation persistence and a responsive chat interface with message history, loading states, empty states, and accessible form controls.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Integrate provider abstraction',
        prompt: 'Add an AI provider service that uses environment-based configuration, supports a deterministic mock when credentials are missing, and keeps prompts centralized and auditable.',
        requiredChecks: ['npm run lint', 'npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Harden chat reliability',
        prompt: 'Add tests for message persistence, provider failures, missing credentials, empty input, and basic prompt-injection guardrails. Document local setup.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: true
      }
    ]
  },
  {
    name: 'Documentation cleanup',
    version: '1.0.0',
    description: 'Refresh project documentation so setup, architecture, workflows, and troubleshooting are accurate and easy to follow.',
    ingredients: ['README', 'Environment variables', 'Architecture notes', 'Command list', 'Troubleshooting guide'],
    steps: [
      {
        title: 'Audit existing docs',
        prompt: 'Read the README and any docs or configuration files. Identify stale setup steps, missing commands, undocumented environment variables, and confusing architecture descriptions. Do not edit files yet.',
        requiredChecks: ['Audit references specific files and gaps'],
        maxRetries: 1,
        requiresApproval: false
      },
      {
        title: 'Rewrite setup and usage',
        prompt: 'Update documentation with clear prerequisites, installation steps, environment configuration, database behavior, run commands, test commands, and common development workflows.',
        requiredChecks: ['npm test'],
        maxRetries: 1,
        requiresApproval: false
      },
      {
        title: 'Document architecture and operations',
        prompt: 'Add or refine architecture notes for routes, controllers, services, persistence, background jobs or runners, and deployment considerations. Include troubleshooting tips for common failures.',
        requiredChecks: ['npm run lint', 'npm test'],
        maxRetries: 1,
        requiresApproval: false
      },
      {
        title: 'Polish examples and links',
        prompt: 'Verify commands, links, headings, and examples. Remove obsolete claims and add concise next-step guidance for contributors.',
        requiredChecks: ['npm test'],
        maxRetries: 1,
        requiresApproval: true
      }
    ]
  },
  {
    name: 'Test hardening',
    version: '1.0.0',
    description: 'Strengthen automated tests with better isolation, edge cases, failure coverage, and reliable commands.',
    ingredients: ['Existing test suite', 'Critical user journeys', 'Fixtures', 'Edge cases', 'CI-friendly commands'],
    steps: [
      {
        title: 'Find fragile coverage',
        prompt: 'Inspect the current test suite and app behavior. Identify high-risk untested paths, flaky setup, shared-state risks, and commands that should run in CI. Do not edit files yet.',
        requiredChecks: ['Audit names specific tests, missing cases, and isolation risks'],
        maxRetries: 1,
        requiresApproval: false
      },
      {
        title: 'Improve test isolation',
        prompt: 'Refactor or add test helpers so tests use isolated fixtures, deterministic data, and clear cleanup. Avoid hiding real failures with broad mocks.',
        requiredChecks: ['npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Add edge-case tests',
        prompt: 'Add tests for validation failures, missing records, permission or approval boundaries, persistence side effects, and representative unhappy paths.',
        requiredChecks: ['npm run lint', 'npm test'],
        maxRetries: 2,
        requiresApproval: false
      },
      {
        title: 'Document quality gates',
        prompt: 'Update contributor or README notes with the test, lint, and build commands expected before merging. Mention any known environment limitations explicitly.',
        requiredChecks: ['npm test', 'npm run build'],
        maxRetries: 1,
        requiresApproval: true
      }
    ]
  }
];

module.exports = builtInRecipeTemplates;
