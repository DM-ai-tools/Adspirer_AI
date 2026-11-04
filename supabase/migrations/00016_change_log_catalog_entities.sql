-- Catalogue fixes (update_product_set_filter, request_feed_refresh) change a shared
-- product set or feed, not a campaign, ad set or ad. Let the change log record them.
alter table public.change_log drop constraint if exists change_log_entity_type_check;
alter table public.change_log
  add constraint change_log_entity_type_check
  check (entity_type in ('campaign', 'adset', 'ad', 'product_set', 'feed'));
