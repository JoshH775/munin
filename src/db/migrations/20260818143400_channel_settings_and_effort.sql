alter table agent_settings rename to channel_settings;

create type effort_level as enum ('low', 'medium', 'high', 'xhigh', 'max');

alter table channel_settings add column effort effort_level; -- null = inherit from the global row
