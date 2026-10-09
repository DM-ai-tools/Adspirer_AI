# Demo seed: `DEMO_MODE` vs real Supabase

Adspirer AI supports two local development paths. Prefer **DEMO_MODE** until you need real auth, RLS, or Adspirer OAuth.

## Quick comparison

| | `DEMO_MODE=true` | Real Supabase |
|---|---|---|
| Database | In-memory (`src/lib/demo/store.ts`) | Postgres via migrations + `seed.sql` |
| Auth | Cookie / demo profiles | Supabase Auth → `profiles` |
| Adspirer tokens | Placeholder encrypted strings | `adspirer_service_account` (service role only) |
| Seed file | Not required | `supabase/seed.sql` |
| Best for | UI, agent mock flow, approvals UX | RLS, multi-user, OAuth, persistence |

---

## Path A — DEMO_MODE (no Supabase)

1. Copy env:

   ```bash
   cp .env.example .env.local
   ```

2. Ensure:

   ```env
   DEMO_MODE=true
   ADS_EXECUTION_MODE=mock
   ```

3. Start the app:

   ```bash
   npm run dev
   ```

4. Demo identities (from the in-memory store):

   - Admin: `admin@spendsmith.demo`
   - Operator: `operator@spendsmith.demo`

You do **not** need Docker, the Supabase CLI, or `seed.sql`. Demo clients (TrafficRadius, ClickTrends, Modern Dental Centre) are created in code and labeled **DEMO DATA**.

---

## Path B — Local Supabase + SQL seed

### Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli)
- Docker running

### Steps

1. Copy env and disable demo mode once keys are available:

   ```bash
   cp .env.example .env.local
   ```

2. Start local stack:

   ```bash
   npx supabase start
   ```

3. Apply migrations + seed:

   ```bash
   npx supabase db reset
   ```

   This runs:

   - `supabase/migrations/00001_foundation.sql`
   - `supabase/seed.sql` (because `[db.seed]` is enabled in `config.toml`)

4. Before public seed inserts succeed, **auth users must exist** for the fixed profile UUIDs.

   In `supabase/seed.sql`, uncomment the **LOCAL AUTH USERS** block, then re-run:

   ```bash
   npx supabase db reset
   ```

   Fixed IDs:

   | Role | Email | UUID |
   |---|---|---|
   | admin | `admin@spendsmith.demo` | `a1111111-1111-4111-8111-111111111111` |
   | operator | `operator@spendsmith.demo` | `a2222222-2222-4222-8222-222222222222` |

   Local demo passwords (auth block only): `demo-password-admin` / `demo-password-operator`.

5. Wire `.env.local` from `npx supabase status`:

   ```env
   DEMO_MODE=false
   ADS_EXECUTION_MODE=mock
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   SUPABASE_SERVICE_ROLE_KEY=<service_role key>
   TOKEN_ENCRYPTION_KEY=<32-byte key, base64>
   APP_URL=http://localhost:3000
   ```

6. Start the app:

   ```bash
   npm run dev
   ```

### What the SQL seed loads (DEMO DATA)

- Admin + operator profiles  
- Clients: TrafficRadius, ClickTrends, Modern Dental Centre  
- Operator `user_client_access` to all three  
- Connected Meta accounts  
- Modern Dental services: **Dental Implants**, **Veneers**  
- Sample competitor brief, monitoring snapshots  
- Pending approval + task/conversation/messages  
- Notifications + ClickTrends access request  
- Placeholder `adspirer_service_account` tokens (not real credentials)

---

## Path C — Hosted Supabase

1. Create a project in the Supabase Dashboard.
2. Run the foundation migration (SQL editor or CLI linked to the project).
3. Create Auth users (Dashboard → Authentication → Users, or Admin API).
4. Align user UUIDs with `seed.sql` **or** edit the fixed UUIDs in `seed.sql` to match the users you created.
5. Run the public-table portion of `supabase/seed.sql` (leave the `auth.users` block commented — hosted auth inserts differ).
6. Set `.env.local` with project URL / anon / service_role keys and `DEMO_MODE=false`.

---

## Safety notes

- Never run `seed.sql` against a production database that serves real clients.
- `adspirer_service_account` has **no** SELECT policies for `anon` / `authenticated`; only the service role (server) may read tokens.
- `tool_calls` is append-only for authenticated roles (no UPDATE/DELETE policies).
- Keep `ADS_EXECUTION_MODE=mock` (or `sandbox`) until the Execute pathway is validated against a test Meta account.
