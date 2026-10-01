-- One catalog row per iRacing track id.
--
-- iRacing gives every layout its own TrackID, so (sim, track_id) already names
-- a layout. config_id is a slug of a layout *name*, and names differ by source:
-- the sim's TrackConfigName says "300 Circuit", Garage 61's variant says "300".
-- Inserting on the full key would file the same layout twice the moment two
-- sources named it differently. So report_session adds a layout only when its
-- track id is new, and the first config_id seen stays the one in use; the app
-- resolves the sim's key to it on connect (cloud-sync.ts, canonicalTrackKey).

create or replace function public.report_session(
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

  if not exists (
    select 1 from public.track_layouts where sim = p_sim and track_id = p_track_id
  ) then
    insert into public.track_layouts (sim, track_id, config_id, track_name, config_name, length_m)
    values (p_sim, p_track_id, p_config_id, left(p_track_name, 120), left(coalesce(p_config_name, ''), 120), p_length_m)
    on conflict do nothing;
  end if;

  if p_car_id is not null then
    insert into public.cars (sim, car_id, name)
    values (p_sim, p_car_id, left(p_car_name, 120))
    on conflict do nothing;
  end if;
end;
$$;

-- The layout a track id already has, for the app to adopt.
create function public.layout_for_track_id(p_sim text, p_track_id integer) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select config_id from public.track_layouts
  where sim = p_sim and track_id = p_track_id
  order by created_at
  limit 1;
$$;

grant execute on function public.layout_for_track_id to anon, authenticated;
