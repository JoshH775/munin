create table reminders (
    id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    -- not an fk cause it needs to work on channels with no settigngs
    channel_id TEXT NOT NULL,
    target TEXT,
    status TEXT NOT NULL CHECK(status in ('pending', 'sent', 'cancelled')) DEFAULT 'pending',
    date timestamptz not null,
    received boolean not null default false,
    created_at timestamptz not null default now()
);

alter table channel_settings add column reminder boolean not null default false;