-- Track maps and reference laps — TODO.md M8 step 2.
--
-- Contributed by whoever drives a layout first, through RPCs rather than table
-- grants, because the rules are not expressible as a policy: the first map per
-- layout wins and is never replaced by a client (a new map_version is an admin
-- action), and a reference lap is replaced only by a faster one.

create table public.track_maps (
  sim text not null,
  track_id integer not null,
  config_id text not null,
  map_version integer not null check (map_version >= 1),
  data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) < 2000000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (sim, track_id, config_id, map_version),
  foreign key (sim, track_id, config_id) references public.track_layouts (sim, track_id, config_id)
);

-- Keyed by TrackKey + car, NO map_version: re-cutting a map must not invalidate
-- laps already driven (SPEC §4.0).
create table public.reference_laps (
  sim text not null,
  track_id integer not null,
  config_id text not null,
  car_id text not null,
  lap_time_s real not null check (lap_time_s > 10),
  data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) < 2000000),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (sim, track_id, config_id, car_id),
  foreign key (sim, track_id, config_id) references public.track_layouts (sim, track_id, config_id),
  foreign key (sim, car_id) references public.cars (sim, car_id)
);

alter table public.track_maps enable row level security;
alter table public.reference_laps enable row level security;

revoke all on public.track_maps, public.reference_laps from anon, authenticated;
grant select on public.track_maps, public.reference_laps to anon, authenticated;

create policy "maps are public" on public.track_maps for select using (true);
create policy "reference laps are public" on public.reference_laps for select using (true);

-- Returns the map version that now stands for the layout: the one submitted if
-- there was none, otherwise the existing one, which the caller should adopt.
create function public.submit_map(
  p_sim text,
  p_track_id integer,
  p_config_id text,
  p_data jsonb
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing integer;
begin
  if auth.uid() is null then
    raise exception 'sign in to share a map' using errcode = '42501';
  end if;
  if p_data -> 'trackRef' ->> 'sim' is distinct from p_sim
     or (p_data -> 'trackRef' ->> 'trackId')::integer is distinct from p_track_id
     or p_data -> 'trackRef' ->> 'configId' is distinct from p_config_id then
    raise exception 'map trackRef does not match the layout it is submitted for';
  end if;
  if jsonb_typeof(p_data -> 'corners') is distinct from 'array' then
    raise exception 'map has no corner list';
  end if;

  -- Serialise concurrent first submissions for one layout.
  perform pg_advisory_xact_lock(hashtext(p_sim || ':' || p_track_id || ':' || p_config_id));

  select max(map_version) into existing
  from public.track_maps
  where sim = p_sim and track_id = p_track_id and config_id = p_config_id;
  if existing is not null then
    return existing;
  end if;

  insert into public.track_maps (sim, track_id, config_id, map_version, data, created_by)
  values (p_sim, p_track_id, p_config_id, 1, jsonb_set(p_data, '{trackRef,mapVersion}', '1'), auth.uid());
  return 1;
end;
$$;

-- True when the lap was taken (none existed, or it is faster).
create function public.submit_reference_lap(
  p_sim text,
  p_track_id integer,
  p_config_id text,
  p_car_id text,
  p_lap_time_s real,
  p_data jsonb
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  taken boolean;
begin
  if auth.uid() is null then
    raise exception 'sign in to share a reference lap' using errcode = '42501';
  end if;

  insert into public.reference_laps as r (sim, track_id, config_id, car_id, lap_time_s, data, created_by)
  values (p_sim, p_track_id, p_config_id, p_car_id, p_lap_time_s, p_data, auth.uid())
  on conflict (sim, track_id, config_id, car_id) do update
    set lap_time_s = excluded.lap_time_s,
        data = excluded.data,
        created_by = excluded.created_by,
        updated_at = now()
    where excluded.lap_time_s < r.lap_time_s
  returning true into taken;

  return coalesce(taken, false);
end;
$$;

revoke all on function public.submit_map, public.submit_reference_lap from public, anon;
grant execute on function public.submit_map, public.submit_reference_lap to authenticated;
