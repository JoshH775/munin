alter table messages add column parent_channel_id TEXT;
alter table messages drop column thread_id;

drop index messages_channel_thread_sent_idx;
create index on messages (channel_id, sent_at);
create index on messages (parent_channel_id);
