-- Workspace documents: operator-uploaded PDF / Word / Markdown for agent context.

create table if not exists public.workspace_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  uploaded_by uuid references public.profiles(id) on delete set null,
  filename text not null,
  mime_type text not null default 'application/octet-stream',
  size_bytes integer not null default 0,
  storage_key text,
  extracted_text text,
  excerpt text,
  doc_kind text not null default 'other'
    check (doc_kind in ('competitor', 'framework', 'brief', 'other')),
  status text not null default 'ready'
    check (status in ('ready', 'failed')),
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_workspace_documents_client
  on public.workspace_documents(client_id, created_at desc);

create index if not exists idx_workspace_documents_conversation
  on public.workspace_documents(conversation_id)
  where conversation_id is not null;

alter table public.workspace_documents enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'workspace_documents'
      and policyname = 'workspace_documents_service_role_all'
  ) then
    create policy workspace_documents_service_role_all
      on public.workspace_documents
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;
