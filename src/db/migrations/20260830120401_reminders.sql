create table reminders (
    id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    channel_id TEXT, -- null falls back to app_settings.reminder_channel_id at dispatch
    target TEXT,
    status TEXT NOT NULL CHECK(status in ('pending', 'sent', 'cancelled')) DEFAULT 'pending',
    date timestamptz not null,
    received boolean not null default false,
    created_at timestamptz not null default now()
);

alter table channel_settings add column reminder boolean not null default false;