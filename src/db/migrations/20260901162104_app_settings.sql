-- App-wide singleton config.
create table app_settings (
    id boolean primary key default true check (id),
    reminder_channel_id text
);
insert into app_settings default values;

alter table channel_settings drop column reminder;
