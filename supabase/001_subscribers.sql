-- Newsletter subscribers for the SockYeh gallery.
--
-- Run this once in the Supabase SQL editor. It creates a table that the static
-- site can INSERT into using only the public `anon` key, which is why no backend
-- has to be deployed. The RLS policy below is deliberately INSERT-only: the
-- browser can add a row but can never read, change or delete one.

create table if not exists public.subscribers (
  id          uuid primary key default gen_random_uuid(),
  email       text        not null unique,
  created_at  timestamptz not null default now(),
  unsubscribed_at timestamptz,
  -- mirrors the Resend segment so the daily job can reconcile the two lists
  resend_synced_at timestamptz
);

create index if not exists subscribers_active_idx
  on public.subscribers (created_at)
  where unsubscribed_at is null;

alter table public.subscribers enable row level security;

-- The site may add subscribers. Nothing else is exposed to `anon`.
drop policy if exists "public can subscribe" on public.subscribers;
create policy "public can subscribe"
  on public.subscribers
  for insert
  to anon
  with check (unsubscribed_at is null);

-- The daily job reads active subscribers using the service-role key, which
-- bypasses RLS, so no SELECT policy is needed or wanted here.

-- Restrict what the anon role can touch, in case it ever gets a grant by mistake.
revoke all on public.subscribers from anon;
grant insert (email) on public.subscribers to anon;
