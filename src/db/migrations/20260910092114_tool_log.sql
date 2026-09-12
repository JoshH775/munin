create table tool_log (
    id bigint generated always as identity primary key,
    in_reply_to text references messages(id) on delete set null,
    channel_id text not null,
    tool text not null,
    input jsonb not null,
    output text,
    error text,
    duration_ms int not null,
    created_at timestamptz not null default now()
);
