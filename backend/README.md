# Support Ticket Dashboard — Backend

A TypeScript REST API for a role-based support ticket management system. The backend manages authentication, ticket workflows, real-time conversations, private attachments, and operational statistics, with PostgreSQL as the source of truth.

Built as the backend of a full-stack portfolio project, with emphasis on resource-level authorization, transactional integrity, maintainable module boundaries, and reproducible integration testing.

## Tech stack

| Layer | Technology |
| --- | --- |
| Runtime & API | Node.js 24 LTS (recommended), Express 5, TypeScript, ES modules |
| Database | PostgreSQL 17, Prisma 7, `@prisma/adapter-pg` |
| Session storage | Redis 8 |
| Authentication | JWT, bcrypt, rotating refresh tokens |
| Validation & logging | Zod 4, Winston |
| Real-time communication | Server-Sent Events (SSE) |
| Object storage | Supabase Storage, Multer, file-type |
| Testing | Vitest, Supertest, isolated PostgreSQL and Redis containers |
| Local infrastructure | Docker Compose |

## Features

- **Authentication & account settings:** registration, login, refresh-token rotation, logout, profile retrieval, name updates, and password changes.
- **Role-based access control (RBAC):** three predefined roles, database-backed permission mappings, authentication-version verification, and protected administrative operations.
- **Ticket management:** resource-scoped visibility, assignment and self-assignment, controlled lifecycle transitions, and modification attribution.
- **Search & pagination:** authorized filtering, case-insensitive literal search, deterministic sorting, and consistent pagination totals.
- **Real-time conversations:** chronological comments and authenticated SSE subscriptions with reconnect snapshots and recipient reauthorization.
- **File attachments:** private object storage, signature validation, bounded uploads, short-lived signed download URLs, and orphan reconciliation.
- **Dashboard statistics:** role-scoped status counts aggregated directly in PostgreSQL.

## Architecture

```mermaid
flowchart LR
    UI[Angular / API client] -->|REST + Bearer JWT| API[Express API]
    API -->|Authenticated SSE| UI
    API --> MW[Authentication / authorization / validation]
    MW --> S[Feature services]
    S -->|Prisma| DB[(PostgreSQL)]
    S -->|Refresh-token sessions| R[(Redis)]
    S -->|Upload / sign / reconcile| OS[Private Supabase bucket]
    UI -->|Short-lived signed download| OS
```

The backend is a **modular monolith**. Routes compose middleware, controllers handle HTTP contracts, and services own business rules and persistence. Shared ticket authorization is reused by listing, comments, attachments, and dashboard aggregation rather than reimplemented within each module.

```text
backend/
├── prisma/
│   ├── migrations/          # Versioned SQL migrations
│   ├── schema.prisma       # Relational data model
│   ├── seed.ts             # Deterministic RBAC synchronization
│   └── provision-admin.ts  # Explicit administrator provisioning
├── scripts/               # Test database migration tooling
├── src/
│   ├── config/             # Database, Redis, storage, logging
│   ├── errors/             # Application error abstraction
│   ├── features/
│   │   ├── auth/
│   │   ├── rbac/
│   │   ├── tickets/
│   │   │   ├── comments/
│   │   │   └── attachments/
│   │   └── dashboard/
│   ├── generated/prisma/   # Generated Prisma client
│   ├── middlewares/       # Authentication, validation, errors, uploads
│   ├── utils/             # Shared authentication utilities
│   ├── app.ts              # Express application composition
│   └── server.ts           # Infrastructure and server lifecycle
├── tests/                 # Unit and integration tests, fixtures, factories
├── docker-compose.yml
├── docker-compose.test.yml
├── prisma7.config.ts
└── vitest.config.ts
```

### Data model

```mermaid
erDiagram
    ROLE ||--o{ USER : grants
    ROLE ||--o{ ROLE_PERMISSION : has
    PERMISSION ||--o{ ROLE_PERMISSION : maps
    USER ||--o{ TICKET : requests
    USER o|--o{ TICKET : assigned_to
    USER o|--o{ TICKET : last_modified_by
    TICKET ||--o{ TICKET_COMMENT : contains
    USER ||--o{ TICKET_COMMENT : authors
    TICKET ||--o{ TICKET_ATTACHMENT : contains
    USER ||--o{ TICKET_ATTACHMENT : uploads
    USER ||--o{ OAUTH_ACCOUNT : links
    USER ||--o{ PASSWORD_RESET_TOKEN : owns
```

Ticket associations preserve historical authorship. Database constraints enforce unique storage keys, case-insensitive email uniqueness, nonempty ticket/comment content, positive attachment sizes, and referential integrity. Composite indexes support ticket visibility and chronological child-resource queries. File bytes reside in object storage; PostgreSQL stores attachment metadata only.

## Getting started

### Prerequisites

- Node.js 24 LTS and npm (recommended runtime).
- Docker with Docker Compose v2.
- Git and a shell (commands below use Bash / Git Bash).
- A Supabase project only if testing actual upload and download functionality.

From the repository root:

```bash
cd backend
npm ci
cp .env.example .env
```

### 1. Configure the environment

Update `.env` with the following development settings. Replace all secret placeholders before starting the server.

```dotenv
NODE_ENV=development
PORT=5000
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/dashboard"
REDIS_URL=redis://localhost:6379
JWT_ACCESS_SECRET=replace_with_random_access_secret
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_SECRET=replace_with_different_random_refresh_secret
JWT_REFRESH_EXPIRES_IN_SECONDS=604800
DEFAULT_USER_ROLE=USER

GOOGLE_CLIENT_ID=local-placeholder
GOOGLE_CLIENT_SECRET=local-placeholder
GOOGLE_CALLBACK_URL=http://localhost:5000/api/v1/auth/google/callback

SUPABASE_URL=
SUPABASE_SECRET_KEY=
SUPABASE_STORAGE_BUCKET=
ATTACHMENT_MAX_COUNT=10
```

Generate two independent JWT secrets by running this command twice:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Google OAuth routes are retained but not part of the core application flow. The current OAuth client requires nonempty configuration at startup; placeholders allow local email/password development but cannot authenticate with Google. Email-based password recovery routes are not exposed. Supabase credentials are required for attachment storage operations; without them, those operations are unavailable and background reconciliation may log errors.

Never commit `.env`, `.env.test`, production credentials, or administrator passwords.

### 2. Start infrastructure and initialize the database

```bash
npm run docker:dev:up
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
npm run seed
```

| Local service | Address |
| --- | --- |
| PostgreSQL | `localhost:5433` |
| Redis | `localhost:6379` |
| pgAdmin (optional) | `http://localhost:5050` |

The Compose credentials are development-only. When connecting to PostgreSQL from pgAdmin inside Compose, use host `postgres`, port `5432`.

### 3. Provision an administrator

Public registration always creates a `USER`. The seed synchronizes roles and permissions but does not create demo accounts. Provision the first administrator explicitly:

```bash
read -r -p "Admin email: " ADMIN_EMAIL
read -r -s -p "Admin password: " ADMIN_PASSWORD; echo
export ADMIN_EMAIL ADMIN_PASSWORD
npm run admin:provision
unset ADMIN_EMAIL ADMIN_PASSWORD
```

The password must contain at least 12 characters and at most 72 UTF-8 bytes. Re-running with matching existing administrator credentials is safe. The command neither silently promotes an existing non-admin account nor resets an existing administrator password.

To create an employee, register a normal user, sign in as the administrator, retrieve the `EMPLOYEE` role ID through `GET /api/v1/rbac/roles`, and assign it using `PATCH /api/v1/rbac/users/:userId/role`.

### 4. Configure private object storage (attachments)

In the Supabase dashboard:

1. Create a project and a **private** Storage bucket dedicated to ticket attachments.
2. Set the bucket's file size limit to 10 MiB and allow JPEG, PNG, WebP, and PDF MIME types.
3. Obtain the project URL and a server-side secret key. Do not expose this key in the Angular application or grant public bucket access.
4. Set `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `SUPABASE_STORAGE_BUCKET` in the backend `.env`.

The application uses its own authentication and authorization before accessing storage. Supabase is used for object storage, not as the application's identity provider or primary database.

### 5. Run the API

```bash
npm run dev
```

Base URL: `http://localhost:5000/api/v1`

For a compiled build:

```bash
npm run build
npm start
```

Stop local infrastructure with `npm run docker:dev:down`. Named development volumes are retained unless explicitly removed.

## Authorization model

Authentication establishes the identity; permissions authorize an operation; resource rules determine whether that operation is allowed for a particular ticket and state.

| Capability | ADMIN | EMPLOYEE | USER |
| --- | --- | --- | --- |
| Create tickets | Yes | Yes | Yes |
| Visible tickets | All | Unassigned, assigned to self, or requested by self | Requested by self |
| Assign / reassign / unassign | Any non-closed ticket | Self-assign visible unassigned non-closed tickets only | No |
| Edit title / description | OPEN or IN_PROGRESS | Assigned: OPEN or IN_PROGRESS; requester: OPEN | Own OPEN tickets |
| Change priority | OPEN or IN_PROGRESS | Assigned OPEN or IN_PROGRESS | No |
| Comment / attach | Visible non-closed tickets | Visible non-closed tickets | Visible non-closed tickets |
| Read closed conversations / attachments | Within visibility scope | Within visibility scope | Within visibility scope |
| View dashboard statistics | All tickets | Visible tickets | Own tickets |
| Manage user roles | Yes | No | No |

All three roles share `ticket:create`, `ticket:read`, `ticket:update`, `ticket:transition`, `ticket:comment`, and `ticket:attach`. The service layer applies further ownership and lifecycle constraints. ADMIN additionally has `ticket:assign`, `user:read`, `user:update`, `role:read`, and `permission:read`; EMPLOYEE additionally has `ticket:self-assign`.

Administrators cannot change their own role or remove the final administrator. An employee cannot change to another role while assigned any non-CLOSED ticket. Historical CLOSED assignments remain intact.

### Ticket lifecycle

```mermaid
stateDiagram-v2
    [*] --> OPEN
    OPEN --> IN_PROGRESS: Start (assignee required)
    IN_PROGRESS --> RESOLVED: Resolve
    RESOLVED --> OPEN: Reopen
    RESOLVED --> CLOSED: Close
    CLOSED --> [*]
```

- A new ticket is OPEN, MEDIUM priority, and unassigned; the requester is derived from the authenticated identity.
- Starting or resolving a ticket requires an administrator or the assigned employee. Starting additionally requires an assignee.
- The administrator, assigned employee, or requester can reopen or close a RESOLVED ticket. Reopening retains its assignee.
- CLOSED is terminal: no edits, reassignment, status changes, comments, or attachments. Authorized reads remain available.
- Only actual ticket mutations change the ticket's `updatedAt` and `updatedBy`. Comments, attachments, and no-op administrative edits do not alter parent-ticket modification metadata.

## API reference

All paths below are relative to `/api/v1`. Protected routes require `Authorization: Bearer <accessToken>`. UUID route parameters refer to database resource IDs.

### Authentication & account

| Method | Path | Input / behavior |
| --- | --- | --- |
| POST | `/auth/register` | `{ email, password, name? }` — creates USER |
| POST | `/auth/login` | `{ email, password }` — returns access token, sets refresh cookie |
| POST | `/auth/refresh` | Refresh cookie — rotates refresh token, returns access token |
| POST | `/auth/logout` | Refresh cookie — removes session, clears cookie; 204 |
| GET | `/auth/me` | Current profile and effective permissions |
| PATCH | `/auth/me` | `{ name }` — updates own profile without revoking sessions |
| PATCH | `/auth/change-password` | `{ currentPassword, newPassword }` — invalidates prior authentication |

Google OAuth endpoints (`GET /auth/google` and `GET /auth/google/callback`) remain in the codebase but are outside the core demo flow. Password recovery requires separate enablement and is not routed.

### Administration (ADMIN only)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/rbac/users` | List users |
| GET | `/rbac/roles` | List roles |
| GET | `/rbac/permissions` | List permissions |
| PATCH | `/rbac/users/:userId/role` | Assign a predefined role using `{ roleId }` |

### Tickets, comments & attachments

| Method | Path | Input / behavior |
| --- | --- | --- |
| POST | `/tickets` | `{ title, description }` |
| GET | `/tickets` | Authorized search, filters, sorting, pagination |
| GET | `/tickets/:ticketId` | Ticket details |
| PATCH | `/tickets/:ticketId` | `{ title?, description?, priority? }` |
| PATCH | `/tickets/:ticketId/assignment` | `{ assigneeId }` — UUID or `null` |
| PATCH | `/tickets/:ticketId/status` | `{ status }` — valid lifecycle transition |
| GET | `/tickets/:ticketId/comments` | Chronological comments |
| POST | `/tickets/:ticketId/comments` | `{ content }` |
| GET | `/tickets/:ticketId/comments/events` | Authenticated SSE conversation stream |
| GET | `/tickets/:ticketId/attachments` | Attachment metadata |
| POST | `/tickets/:ticketId/attachments` | `multipart/form-data` with one `file` field |
| GET | `/tickets/:ticketId/attachments/:attachmentId/download` | Short-lived signed download URL |

### Dashboard

`GET /dashboard/stats` returns counts for all tickets visible to the authenticated actor, independent of listing pagination:

```json
{
  "data": {
    "total": 12,
    "open": 5,
    "inProgress": 3,
    "resolved": 2,
    "closed": 2
  }
}
```

### Ticket query parameters

| Parameter | Accepted values / behavior |
| --- | --- |
| `search` | Literal case-insensitive substring in title or description, 1–200 characters |
| `status` | `OPEN`, `IN_PROGRESS`, `RESOLVED`, `CLOSED` |
| `priority` | `LOW`, `MEDIUM`, `HIGH` |
| `assigneeId` | UUID |
| `assignment` | `assigned`, `unassigned` |
| `page` | Positive integer; default 1 |
| `limit` | 1–100; default 20 |
| `sortBy` | `createdAt`, `updatedAt`, `priority`; default `createdAt` |
| `sortOrder` | `asc`, `desc`; default `desc` |

Unknown parameters, repeated values, incompatible filters (`unassigned` with `assigneeId`), and offsets over 100,000 are rejected. Visibility and filters are combined with `AND`; search wildcards are escaped. Sorting always includes the ID as a tie-breaker. A repeatable-read transaction keeps results and counts consistent.

Example: `GET /tickets?status=OPEN&assignment=unassigned&page=1&limit=20`

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0
  }
}
```

### Response conventions

Resource responses generally use `{ "data": ... }`; registration and login also return a message. Successful creation returns 201; successful logout returns 204 with no response body. Participant objects contain only `id` and `name` (nullable). Timestamps are serialized as ISO 8601 strings.

Errors use a centralized JSON contract:

```json
{
  "status": "error",
  "message": "Ticket not found"
}
```

Validation errors include an additional `errors` array with Zod issues.

| Status | Meaning |
| --- | --- |
| 400 | Invalid input or malformed request |
| 401 | Missing, invalid, expired, or revoked authentication |
| 403 | Operation forbidden |
| 404 | Missing or non-visible resource |
| 408 | Upload timeout |
| 409 | Business-rule or state conflict |
| 413 | Request/file too large |
| 415 | Unsupported or mismatched file type |
| 500 | Unexpected server failure |
| 503 | Storage service unavailable |

## Engineering highlights

### Authentication and session security

- Passwords are hashed with bcrypt; email addresses are normalized and protected by a case-insensitive database uniqueness constraint.
- Access tokens carry role and authentication versions. PostgreSQL is consulted for current user and role versions rather than relying on cached authorization state.
- Refresh tokens are stored as SHA-256 hashes in Redis with TTLs and atomically consumed through `GETDEL` during rotation.
- Refresh cookies are HttpOnly, SameSite=Strict, and Secure in production. Logout removes the refresh session, while existing access tokens remain valid until expiry unless invalidated by an authentication-version change.
- Password changes use compare-and-swap persistence to protect against concurrent updates and increment the user authentication version. Profile name updates do not revoke sessions and preserve timestamps on no-op requests.

### Transactional integrity

Ticket mutations and RBAC role changes share a PostgreSQL transaction-scoped advisory lock, with ticket row locks and authorization rechecks before mutation. This protects concurrent employee self-assignment, closing versus child-resource creation, and employee role changes versus ticket assignment.

The shared visibility predicate is also used by dashboard aggregation. A single database `groupBy` query produces all status counts; totals are derived from those counts, avoiding unnecessary queries or caches.

### Real-time conversations

The client posts comments over REST and receives updates through SSE. This avoids bidirectional socket infrastructure when only server-to-client notifications are required.

```text
GET /api/v1/tickets/:ticketId/comments/events
Authorization: Bearer <accessToken>
Accept: text/event-stream
```

| Event | Payload |
| --- | --- |
| `comments.snapshot` | `{ data: TicketComment[] }` — initial/reconnect state |
| `comment.created` | `{ data: TicketComment }` — persisted comment |
| `stream.error` | `{ status: number, message: string }` — terminal stream failure |

Events are published only after persistence commits. Subscribers are reauthorized before delivery and on 15-second heartbeats. Disconnects remove subscriptions; slow response buffers are bounded. Reconnecting clients receive a fresh database snapshot.

The frontend should use authenticated fetch-based SSE consumption because native browser `EventSource` cannot set a bearer Authorization header. Reconnect with a valid token, replace state on snapshots, deduplicate comments by ID, and sort by `createdAt` then `id`. Close the stream when leaving a ticket or logging out. Existing client-side snapshots may need refreshing after participant name changes.

### Private attachment storage

| Constraint | Value |
| --- | --- |
| Max file size | 10 MiB |
| Max attachments per ticket | 10 by default, configurable |
| Formats | JPEG, PNG, WebP, PDF |
| Upload timeout | 30 seconds |
| Storage request timeout | 10 seconds |
| Signed URL TTL | 60 seconds |
| Orphan reconciliation | Hourly, with a one-hour grace period |

Uploads are authorized before multipart processing. Filename, declared MIME type, detected file signature, extension, and size are validated. Objects use generated keys, not user-supplied filenames.

Storage upload occurs outside the database transaction. The service then reacquires locks and rechecks authorization, ticket state, and attachment count before saving metadata. On failure, compensation synchronizes with persistence and removes only unreferenced objects; uncertain cleanup is deferred to the reconciliation process. Signed downloads are ticket-scoped, force attachment download, and return non-cacheable URL responses. Previously issued signed URLs remain usable until expiration.

## Testing

Unit tests exercise validation, middleware, and authorization logic. Integration tests exercise the HTTP API, database constraints, authentication, role transitions, concurrent ticket mutations, SSE, attachment compensation, dashboard consistency, and profile updates. Integration tests use real PostgreSQL and Redis instances; external storage behavior is mocked in attachment tests.

Create a separate `.env.test` in `backend/`:

```dotenv
NODE_ENV=test
DATABASE_URL="postgresql://postgres:postgres@localhost:5434/dashboard_test"
REDIS_URL=redis://localhost:6380
JWT_ACCESS_SECRET=local_test_access_secret_not_for_production
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_SECRET=local_test_refresh_secret_not_for_production
JWT_REFRESH_EXPIRES_IN_SECONDS=604800
DEFAULT_USER_ROLE=USER
GOOGLE_CLIENT_ID=test-client-id
GOOGLE_CLIENT_SECRET=test-client-secret
GOOGLE_CALLBACK_URL=http://localhost:5000/api/v1/auth/google/callback
ATTACHMENT_MAX_COUNT=10
```

Run the test environment and complete suite:

```bash
npm run test:setup
npm test
```

Additional commands:

```bash
npm run test:integration             # Integration tests only
npm run test:coverage                # Coverage report and thresholds
npm run test:watch                   # Interactive watch mode
npm run docker:test:down             # Stop and remove test containers
```

Coverage reports are written to `coverage/`; open `coverage/index.html` for the HTML report. Configured thresholds are 70% statements, 50% branches, 65% functions, and 70% lines; these are configured quality gates, not a claim of measured coverage.

**Test isolation:** environment guards require `NODE_ENV=test`, PostgreSQL at `localhost:5434/dashboard_test`, and Redis at `localhost:6380`. Integration setup truncates test tables and flushes test Redis between cases. Never point these commands at development or production data.

## Deployment & trade-offs

- Deploy the compiled API with managed or self-hosted PostgreSQL and Redis, private Supabase Storage, strong environment-managed secrets, and HTTPS. Apply migrations and synchronize RBAC before serving traffic.
- Prefer same-origin frontend/API routing: the current application does not configure general cross-origin CORS middleware, and refresh cookies use SameSite=Strict. Configure reverse-proxy streaming without buffering or short idle timeouts for SSE.
- Current live subscriptions are in-memory and designed for a single Express instance. Horizontal scaling would require a shared event distribution mechanism (for example Redis Pub/Sub) and a review of connection routing. SSE delivery is best-effort; snapshots recover persisted comments after reconnect.
- The global advisory lock favors consistency over maximum mutation throughput. At higher concurrency, consider finer-grained locking and separate event authorization strategies, retaining the same business invariants.
- The application bounds individual uploads and attachment counts; dedicated rate limiting, malware scanning, and distributed upload quotas are not implemented in this scope. File signature checks are not a substitute for malware scanning.
- Winston writes structured logs to `logs/combined.log` and `logs/error.log`, with console output in non-production environments. Production deployment should arrange persistent/centralized logging and secret-safe log handling.
- The supplied Docker Compose files are local dependency environments, not a production deployment definition.

The architecture intentionally avoids additional services, message brokers, and redundant caches until the application requires them. The current implementation prioritizes correctness, testability, and a clear path to frontend integration.
