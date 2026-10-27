-- Archive instead of delete: an archived client is hidden from the portal, pickers,
-- dashboard and monitoring, but keeps all of its history (approvals, creatives,
-- documents, conversations). Restoring sets the column back to null. Idempotent.

alter table public.clients
  add column if not exists archived_at timestamptz;

create index if not exists clients_archived_at_idx
  on public.clients (archived_at)
  where archived_at is not null;
