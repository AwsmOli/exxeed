-- Catalog: sims, track layouts, car classes, cars — TODO.md M8 step 0.
--
-- Read-only to clients. Rows arrive two ways: the seed, and report_session(),
-- which a signed-in app calls on connect with what the sim itself reported —
-- insert-if-absent, never an overwrite, so one bad client cannot rename a
-- track for everyone.
--
-- There is no separate `tracks` table. iRacing gives every layout its own
-- TrackID (packages/telemetry/src/iracing.ts), so (sim, track_id) already names
-- a layout; `track_name` carries the physical track for grouping in Content.

create table public.sims (
  id text primary key check (id ~ '^[a-z0-9-]{1,40}$'),
  name text not null
);

create table public.track_layouts (
  sim text not null references public.sims (id),
  track_id integer not null check (track_id >= 0),
  config_id text not null check (config_id ~ '^[a-z0-9-]{1,80}$'),
  track_name text not null check (char_length(track_name) between 1 and 120),
  config_name text not null default '' check (char_length(config_name) <= 120),
  length_m real check (length_m between 100 and 50000),
  -- The official numbering, learned from guides (apps/desktop/src/track-knowledge.ts).
  turn_numbers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (sim, track_id, config_id)
);

create table public.car_classes (
  sim text not null references public.sims (id),
  class_id text not null check (class_id ~ '^[a-z0-9-]{1,80}$'),
  name text not null,
  primary key (sim, class_id)
);

create table public.cars (
  sim text not null references public.sims (id),
  car_id text not null check (car_id ~ '^[a-z0-9-]{1,80}$'),
  name text not null check (char_length(name) between 1 and 120),
  -- Null until someone decides which class a newly reported car belongs to
  -- (§13's granularity question, answered in data).
  class_id text,
  primary key (sim, car_id),
  foreign key (sim, class_id) references public.car_classes (sim, class_id)
);

alter table public.sims enable row level security;
alter table public.track_layouts enable row level security;
alter table public.car_classes enable row level security;
alter table public.cars enable row level security;

revoke all on public.sims, public.track_layouts, public.car_classes, public.cars from anon, authenticated;
grant select on public.sims, public.track_layouts, public.car_classes, public.cars to anon, authenticated;

create policy "catalog is public" on public.sims for select using (true);
create policy "catalog is public" on public.track_layouts for select using (true);
create policy "catalog is public" on public.car_classes for select using (true);
create policy "catalog is public" on public.cars for select using (true);

-- What the sim reported on connect. Signed-in only, so a row can be traced to
-- someone if it turns out to be junk.
create function public.report_session(
  p_sim text,
  p_track_id integer,
  p_config_id text,
  p_track_name text,
  p_config_name text,
  p_length_m real,
  p_car_id text,
  p_car_name text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in to report a session' using errcode = '42501';
  end if;

  insert into public.track_layouts (sim, track_id, config_id, track_name, config_name, length_m)
  values (p_sim, p_track_id, p_config_id, left(p_track_name, 120), left(coalesce(p_config_name, ''), 120), p_length_m)
  on conflict do nothing;

  if p_car_id is not null then
    insert into public.cars (sim, car_id, name)
    values (p_sim, p_car_id, left(p_car_name, 120))
    on conflict do nothing;
  end if;
end;
$$;

revoke all on function public.report_session from public, anon;
grant execute on function public.report_session to authenticated;
