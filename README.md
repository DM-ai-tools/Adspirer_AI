# Spendsmith

Autonomous Meta advertising intelligence and operations platform for agencies. Operators manage dozens of client Meta ad accounts through natural-language workspace chat, with a code-level policy gate that blocks Execute mutations until a human approves them.

## Quick start (DEMO_MODE)

```bash
cp .env.example .env.local
# Ensure DEMO_MODE=true and ADS_EXECUTION_MODE=mock
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). No Supabase, Facebook, or Trigger.dev credentials are required for the mock demo path.

## Live mode (Supabase auth + clients)

1. Set `DEMO_MODE=false` and fill `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.
2. In the Supabase dashboard → **SQL Editor**, paste and run `supabase/migrations/00001_foundation.sql` (required — without it APIs return auth/profile errors and you cannot add clients).
3. Restart `npm run dev`, register/sign in. The first user is promoted to **admin** automatically so you can create clients.

```bash
npm test          # vitest run
npm run test:watch
npm run typecheck
```

## Demo credentials

| Role | Email |
|------|--------|
| Admin | `admin@spendsmith.demo` |
| Operator | `operator@spendsmith.demo` |

In DEMO_MODE, identity is selected via the demo login cookie (`adspirer_demo_user`, kept for existing sessions). Seeded clients: **TrafficRadius**, **ClickTrends**, **Modern Dental Centre** (all labeled DEMO DATA).

## Demo flow (steps 1–20, abbreviated)

1. Admin logs in  
2. Connect Facebook under Connections  
3. Sync accessible Meta accounts  
4. Create **Modern Dental Centre**  
5. Map its Meta account  
6. Set budget ceiling + services (implants / veneers)  
7. Operator opens workspace  
8. Ask: *Audit the account and tell me what I should improve*  
9. Agent runs Diagnose tools only  
10. Evidence-backed recommendations appear  
11. Ask: *Implement the highest priority recommendation*  
12. Agent proposes an Execute tool  
13. Policy gate intercepts it  
14. Approval card appears  
15. Operator approves  
16. Agent / task resumes  
17. Execute reaches Meta (mock provider in DEMO_MODE)  
18. Result is recorded  
19. UI shows change completed  
20. Audit page shows full request → execution history  

## Environment variables (overview)

| Variable | Purpose |
|----------|---------|
| `DEMO_MODE` | In-memory store when `true` (default for local) |
| `ADS_EXECUTION_MODE` | `mock` \| `sandbox` \| `production` |
| `TOKEN_ENCRYPTION_KEY` | 32-byte AES key (64-char hex or base64) |
| `NEXT_PUBLIC_SUPABASE_*` / `SUPABASE_SERVICE_ROLE_KEY` | Live DB + auth |
| `ANTHROPIC_API_KEY` | Claude / Mastra agent |
| `META_APP_ID` / `META_APP_SECRET` | Facebook OAuth app for direct Meta access |
| `AGENT_BACKGROUND_RUNS` | Run chat turns as Trigger.dev jobs (needs the worker) |
| `TRIGGER_SECRET_KEY` | Trigger.dev schedules |
| `ACCESS_REQUEST_STALE_DAYS` | Stale access job threshold |
| `APPROVAL_EXPIRY_HOURS` | Approval TTL |
| `BUDGET_CEILING_DEFAULT_CENTS` | Default client ceiling |

See `.env.example` for the full list.

## Architecture sketch

```
Operator UI (Next.js)
        │
API / authz + Zod
        │
 ├── Policy gate (diagnose | execute | blocked)
 ├── Approval service + budget ceiling + idempotency
 ├── Task runner (inline, or a Trigger.dev job)
 └── MetaAdsProvider (Mock | Meta Graph via Facebook OAuth)
        │
Trigger.dev jobs (monitor, sync, stale access, token refresh, …)
```

Hard rules: unknown tools are blocked; Execute never runs without an approved (or edited) approval; operators never see stored Facebook tokens; client access is enforced server-side.

## Phase status

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Foundation: auth, profiles, roles, seed | Done (DEMO_MODE) |
| 1 | Client management, brand, services | Done (API + demo store) |
| 2 | Facebook OAuth, token vault, account sync | Done |
| 3 | Access requests, Gmail/manual, stale jobs | Done (mock Gmail + stale job) |
| 4 | Mastra agent, diagnose tools, workspace | Done (mock agent path) |
| 5 | Policy gate, approvals, budget, idempotency | Done + tests |
| 6 | Competitor intelligence + briefs | Done (mock providers) |
| 7 | Creative concepts | Partial / planned |
| 8 | Monitoring + Trigger.dev schedules | Done (jobs + analyzer) |
| 9 | Hardening, export, tests, production gate | In progress |

Details: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Operations

- Backups & keepalive: see [`docs/BACKUPS.md`](docs/BACKUPS.md).
- Rotating `TOKEN_ENCRYPTION_KEY`: `scripts/rotate-token-key.mjs`.
- Moving inline creative images to Cloudinary: `scripts/migrate-creatives-to-cloudinary.mjs`.
