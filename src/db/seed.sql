-- idempotent: runs on db:reset
insert into channel_settings (channel_id, model, effort)
values ('global', 'claude-sonnet-5', 'medium')
on conflict (channel_id) do nothing;
