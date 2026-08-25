-- idempotent: runs on db:reset
insert into channel_settings (channel_id, model, effort)
values ('global', 'zai-org/GLM-5.2', 'high')
on conflict (channel_id) do nothing;
