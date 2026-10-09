# Database backups

The free Supabase plan has no automatic backups and pauses a project after
7 days without activity. `.github/workflows/supabase-backup.yml` covers both:

- **Keepalive:** a daily request to the Supabase REST API.
- **Backup:** a daily `supabase db dump` (roles, schema and data), encrypted
  with your passphrase and kept as a GitHub Actions artifact for 30 days.

## One-time setup

In GitHub → **Settings → Secrets and variables → Actions**, add:

| Secret | Where to find it |
|---|---|
| `SUPABASE_DB_URL` | Supabase → Project → **Connect** → *Session pooler* URI (with the database password filled in) |
| `SUPABASE_URL` | Same value as `NEXT_PUBLIC_SUPABASE_URL` |
| `SUPABASE_ANON_KEY` | Same value as `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `BACKUP_PASSPHRASE` | Any long random string. Store it in your password manager: without it the backups cannot be opened. |

Then open **Actions → Supabase backup & keepalive → Run workflow** once to
check that both jobs pass.

## Restoring

1. Download the newest `spendsmith-db-*.tar.gz.gpg` artifact from the workflow run.
2. Decrypt and unpack it:

   ```bash
   gpg --decrypt spendsmith-db-<stamp>.tar.gz.gpg > backup.tar.gz
   tar -xzf backup.tar.gz   # creates dump/roles.sql, dump/schema.sql, dump/data.sql
   ```

3. Restore into a new or empty Supabase project (session pooler URI):

   ```bash
   psql --single-transaction --variable ON_ERROR_STOP=1 \
     --file dump/roles.sql --file dump/schema.sql \
     --command 'SET session_replication_role = replica' \
     --file dump/data.sql \
     --dbname "<new project connection string>"
   ```

4. Point `.env.local` (and your host) at the restored project. Keep the same
   `TOKEN_ENCRYPTION_KEY`, or stored Facebook tokens will not decrypt.

## When to move to Supabase Pro

Pro ($25/month) adds daily managed backups and never pauses. Upgrade when you
onboard paying clients, the database passes ~350 MB, or egress passes
~3.5 GB/month (Supabase → Project → **Usage**).
