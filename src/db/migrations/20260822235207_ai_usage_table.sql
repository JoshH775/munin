create table usage (
    id bigint generated always as identity PRIMARY KEY ,
    in_reply_to TEXT references messages(id) on delete set null,
    model text not null,
    effort text not null,
    input_tokens int not null,
    output_tokens int not null,
    cache_read_input_tokens int not null,
    cache_creation_input_tokens int not null,
    created_at timestamptz not null default now()
);