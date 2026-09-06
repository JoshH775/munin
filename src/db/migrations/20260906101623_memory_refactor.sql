alter table channel_settings drop column if exists system_prompt;

create table memory (
    channel_id text primary key references channel_settings(channel_id) on delete cascade,
    content text not null,
    as_of timestamp with time zone not null,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null
);

insert into memory (channel_id, content, as_of)
select channel_id, memory, now()
from channel_settings
where memory is not null and btrim(memory) <> '';

alter table channel_settings drop column if exists memory;

