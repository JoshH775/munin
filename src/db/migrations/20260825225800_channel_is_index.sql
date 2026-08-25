alter table channel_settings add column is_index boolean not null default false;
-- only one channel can be the index at a time
create unique index only_one_index on channel_settings (is_index) where is_index;
