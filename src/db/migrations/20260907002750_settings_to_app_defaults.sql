-- Model/effort become app-wide defaults; mute becomes a per-channel boolean; drop the reminder channel.
-- No cross-table backfill — hardcode the current prod values.

alter table app_settings add column chat_model text;
alter table app_settings add column effort effort_level;
update app_settings set chat_model = 'zai-org/GLM-5.2', effort = 'high';
alter table app_settings alter column chat_model set not null;
alter table app_settings alter column effort set not null;
alter table app_settings drop column reminder_channel_id;

alter table channel_settings add column muted boolean not null default false;
update channel_settings set muted = true
  where channel_id in ('1042154390498328616', '1539609709974257784');
delete from channel_settings where channel_id = 'global';
alter table channel_settings drop column model;
alter table channel_settings drop column effort;
alter table channel_settings drop column disabled_at;
