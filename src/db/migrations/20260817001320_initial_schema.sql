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
    channel_id TEXT NOT NULL, -- the life domain; a thread resolves to its parent channel
    thread_id TEXT,           -- null = top-level channel message; else the discord thread id
    user_id TEXT NOT NULL, -- discord snowflake
    user_name TEXT NOT NULL,
    content TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL,                  -- when the message was sent on discord (message.createdAt)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()  -- when this row was inserted (bookkeeping)
);

create index messages_channel_thread_sent_idx on messages (channel_id, thread_id, sent_at);