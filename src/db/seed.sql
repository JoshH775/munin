-- idempotent: runs on db:reset
insert into channel_settings (channel_id, model, effort)
values ('global', 'moonshotai/Kimi-K2.6', 'high')
on conflict (channel_id) do nothing;
