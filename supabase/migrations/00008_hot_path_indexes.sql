-- Composite indexes for the queries every chat turn and page load runs.
-- Each replaces a "filter by one column, then sort" plan with a direct scan.

-- Thread load: messages for a conversation, oldest first.
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

-- Chat history list: a client's conversations, most recent first.
create index if not exists conversations_client_updated_idx
  on public.conversations (client_id, updated_at desc);

-- Research memo / dashboard: a client's latest tasks.
create index if not exists tasks_client_updated_idx
  on public.tasks (client_id, updated_at desc);

-- Competitor uploads are always listed per client.
create index if not exists v2_competitor_upload_batches_client_idx
  on public.v2_competitor_upload_batches (client_id);

-- Expired PKCE rows are never read again; keep the table from growing forever.
delete from public.oauth_pkce_state where expires_at < now() - interval '1 day';
