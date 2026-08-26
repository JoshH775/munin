-- parent is Discord's data, always derived live from channel.parentId; the column was write-only.
-- (its index drops automatically with the column.)
alter table messages drop column parent_channel_id;
