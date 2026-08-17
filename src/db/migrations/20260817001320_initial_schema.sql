create table agent_settings (
    channel_id TEXT NOT NULL PRIMARY KEY, -- discord snowflake; the 'global' row holds persona, global memory, and default model
    model TEXT,                           -- null = default model
    system_prompt TEXT,                   -- null = global persona only
    memory TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

create table messages (
    id TEXT NOT NULL PRIMARY KEY,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL, -- discord snowflake
    user_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

create index messages_channel_created_idx on messages (channel_id, created_at);