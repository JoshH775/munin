create table global_memory (
    id boolean primary key default true check (id),
    content TEXT NOT NULL,
    description TEXT,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

insert into global_memory (content, created_at, updated_at)
select content, created_at, updated_at from memory where channel_id = 'global';

delete from channel_settings where channel_id = 'global';

alter table memory drop column as_of;
alter table memory add column description TEXT;
alter table channel_settings add column last_memory_sweep_at timestamptz;

