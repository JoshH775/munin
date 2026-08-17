-- idempotent: runs after every db:push
insert into agent_settings (channel_id)
values ('global')
on conflict (channel_id) do nothing;
