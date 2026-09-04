-- One Life Admin settings tables
-- Run this once in Supabase SQL Editor.

create table if not exists public.app_statuses (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  position integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_fields (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  field_type text not null default 'text'
    check (field_type in ('text','select','date','checkbox','user')),
  position integer not null default 0,
  is_active boolean not null default true,
  is_required boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.app_statuses (key, label, position)
values
  ('new', '新規', 0),
  ('in_progress', '作成中', 1),
  ('done', '完了', 2)
on conflict (key) do nothing;

insert into public.app_fields (key, label, field_type, position)
values
  ('assignee', '担当者', 'user', 0),
  ('priority', '優先度', 'select', 1),
  ('due_date', '締切', 'date', 2),
  ('check', 'チェック', 'checkbox', 3)
on conflict (key) do nothing;

alter table public.app_statuses enable row level security;
alter table public.app_fields enable row level security;

drop policy if exists "statuses read authenticated" on public.app_statuses;
create policy "statuses read authenticated"
on public.app_statuses for select
to authenticated
using (true);

drop policy if exists "fields read authenticated" on public.app_fields;
create policy "fields read authenticated"
on public.app_fields for select
to authenticated
using (true);

drop policy if exists "statuses admin write" on public.app_statuses;
create policy "statuses admin write"
on public.app_statuses for all
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = 'admin'
  )
)
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = 'admin'
  )
);

drop policy if exists "fields admin write" on public.app_fields;
create policy "fields admin write"
on public.app_fields for all
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = 'admin'
  )
)
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = 'admin'
  )
);
