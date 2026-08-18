# Adspirer AI — Implementation Plan

## Current Repository State

| Item | Status |
|------|--------|
| Source code | Implemented foundation through monitoring/jobs |
| Package manager | npm |
| Framework | Next.js 16 (App Router) + React 19 + TypeScript strict + Tailwind CSS 4 |
| Auth / DB | Supabase migrations + seed; DEMO_MODE in-memory store |
| Agent | Mastra + Claude (Anthropic) with mock agent path |
| Jobs | Trigger.dev adapters in `trigger/` (plain functions + optional SDK wrappers) |
| Tests | Vitest suite under `tests/` |
| UI | Custom SaaS shell + shadcn-style primitives |

## Architecture Summary

```
Operator UI (Next.js)
        │
    ▼
API / Server Actions (authz + Zod)
        │
        ├── Policy Gate (DIAGNOSE | EXECUTE | BLOCKED)
        ├── Approval Service (human-in-the-loop)
        ├── Budget Ceiling Validator
        └── Task Runner (Mastra AdspirerAgent)
                    │
                    ├── Diagnose tools → MetaAdsProvider (Adspirer MCP / Mock)
                    └── Execute tools → ONLY after approved approval + idempotency key
```

### Hard constraints

1. **Agent-led** — Mastra decides tool order; no fixed workflow DAG.
2. **Meta Ads only** — `MetaAdsProvider` abstraction; first impl `AdspirerMCPProvider` + `MockMetaAdsProvider`.
3. **Policy gate outside the LLM** — Execute tools cannot run without an approved approval record.
4. **Shared Adspirer service account** — operators never see Adspirer tokens.
5. **Client-scoped multi-tenancy** — every resource has `client_id`; backend validates assignment.
6. **Fail closed** — unknown tools, missing approval, failed decryption, budget violations → BLOCK.

## Migration Plan

1. Apply `supabase/migrations/00001_foundation.sql` (schema + RLS).
2. Apply seed via `supabase/seed.sql` (DEMO DATA only; not in production migrations).
3. Configure `.env.local` from `.env.example`.
4. Run `npm run dev` — app works in mock mode without live Adspirer/Supabase if `DEMO_MODE=true`.
5. Run `npm test` — policy, approvals, budget, authz, vault, task durability.

## Phased Delivery

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Foundation: auth, profiles, roles, nav, seed | **Done** (DEMO_MODE + Supabase schema) |
| 1 | Client management, brand context, services | **Done** (API + demo store) |
| 2 | Adspirer OAuth, token vault, account sync | **Done** (interfaces + mock; live behind env) |
| 3 | Access requests, Gmail/manual send, stale jobs | **Done** (mock Gmail + `stale-access` job) |
| 4 | Mastra agent, diagnose tools, workspace | **Done** (mock agent + diagnose tools) |
| 5 | Policy gate, approvals, budget, audit, idempotency | **Done** (+ vitest coverage) |
| 6 | Competitor intelligence + briefs | **Done** (mock providers + research job) |
| 7 | Creative concepts from brand + competitor context | **Done** (generator + `/api/creatives/generate` + UI) |
| 8 | Monitoring snapshots + Trigger.dev schedules | **Done** (analyzer + job modules) |
| 9 | Hardening, export, tests, production mode gate | **Done** (vitest 22, audit CSV, production mode gate in executor) |

## Unresolved External Integrations

| Integration | Approach |
|-------------|----------|
| Adspirer MCP / OAuth | Interface + Mock; real client behind `ADSPIRER_*` env vars (TODO when API docs available) |
| Gmail | Interface + Mock; mark-sent-manually always available |
| Firmographic / Traffic | Provider interfaces + mock adapters |
| Meta Ad Library | `AdIntelligenceProvider` + mock |
| Foreplay | Optional `AdIntelligenceProvider` — not a hard dependency |
| Cloudflare R2 | Object storage interface; local mock for creatives |
| Trigger.dev | Job definitions in `trigger/`; run as plain functions without secret |

## Risks

- Adspirer MCP tool names unknown → keep provider methods domain-oriented, not MCP-shaped.
- Supabase not provisioned in all envs → `DEMO_MODE` in-memory/mock DB path for local UX.
- Double-execution risk → idempotency keys on Execute pathway (Phase 5) + retry job reuse.
- Cross-client leakage → RLS + server-side `assertClientAccess` on every handler.

## Assumptions

- Single active `adspirer_service_account` row.
- New campaigns created **PAUSED** by default.
- `ADS_EXECUTION_MODE` defaults to `mock` until explicitly set to `production`.
- Claude via Anthropic is the reasoning model; Mastra wraps tool calling.
- Seeded demo clients: TrafficRadius, ClickTrends, Modern Dental Centre.
