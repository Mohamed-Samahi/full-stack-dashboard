# Claude Code — Project Instructions

## Project Context

This repository contains an existing Express.js backend and a frontend
application to be developed using Next.js, React, and TypeScript.

The frontend will demonstrate authentication and role-based access control
(RBAC), with a strong focus on permission-based authorization using the `can()`
approach.

## Backend API — Single Source of Truth

- `docs/API_CONTRACT.md` is the **only authorized source of backend API
  information**.
- Do NOT read, search, list, or explore files inside `backend/`.
- Do NOT inspect backend controllers, routes, services, middleware, Prisma
  schemas, or database configuration.
- Do NOT use Git history or external sources to discover backend behavior.
- Do NOT invent endpoints, payloads, responses, roles, or permissions.
- If information is missing or ambiguous in `API_CONTRACT.md`, report the exact
  gap instead of exploring the backend.
- Do not modify any files inside `backend/`.

## Frontend Development

- Create the frontend inside `frontend/`.
- Use Next.js App Router, TypeScript, Tailwind CSS, and shadcn/ui.
- Use TanStack Query for server state and React Hook Form with Zod for
  validation.
- Keep the architecture modular, reusable, scalable, and maintainable.
- Consume all documented authentication and authorization endpoints.

## RBAC

- Implement a centralized `can()` authorization utility.
- Build reusable permission-aware hooks and components.
- Derive permissions from the documented backend contract.
- Do not hardcode role names throughout UI components.
- Treat backend authorization as the security boundary.
- Demonstrate allowed and denied actions clearly.

## UI Design

- Use the installed `unslop` skill.
- Build a polished, professional SaaS-style application.
- Prioritize visual hierarchy, typography, spacing, accessibility,
  responsiveness, and usability.
- Avoid generic AI-generated dashboard patterns.

## Token Efficiency

- Read `docs/API_CONTRACT.md` once at the beginning of implementation.
- Do not recursively explore the repository.
- Inspect only relevant frontend files when necessary.
- Avoid repeatedly reading unchanged files.
- Keep responses concise.
- Prioritize implementation over lengthy explanations.

## Execution Boundaries

- Never modify backend files.
- Do not perform destructive commands without explicit approval.
- Do not add mock API responses that pretend to be real backend functionality.
- Document any missing API capabilities rather than implementing fictional
  behavior.
