-- Composite indexes for the portal list/status polls, plus a one-time rewrite
-- so list queries never transfer multi-MB data URIs in image_url.

create index if not exists creative_drafts_client_conversation_updated_idx
  on public.creative_drafts (client_id, conversation_id, updated_at desc);

create index if not exists creative_drafts_client_status_updated_idx
  on public.creative_drafts (client_id, status, updated_at desc);

create index if not exists approvals_client_status_created_idx
  on public.approvals (client_id, status, created_at desc);

-- Bytes stay in image_b64 and are served by /api/creatives/assets/:id.
update public.creative_drafts
set image_url = null
where image_url like 'data:%';
