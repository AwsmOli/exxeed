-- submit_map says whether it took the map, not only which version stands.
--
-- Returning just the version could not tell "yours is v1 now" from "someone
-- else's v1 was already there", which is the difference between "shared your
-- map" and "adopted theirs" — and the second should make the app pull the
-- standing map rather than go on believing its own is the shared one.

drop function public.submit_map(text, integer, text, jsonb);

create function public.submit_map(
  p_sim text,
  p_track_id integer,
  p_config_id text,
  p_data jsonb
) returns table (map_version integer, accepted boolean)
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

  perform pg_advisory_xact_lock(hashtext(p_sim || ':' || p_track_id || ':' || p_config_id));

  select max(m.map_version) into existing
  from public.track_maps m
  where m.sim = p_sim and m.track_id = p_track_id and m.config_id = p_config_id;
  if existing is not null then
    return query select existing, false;
    return;
  end if;

  insert into public.track_maps (sim, track_id, config_id, map_version, data, created_by)
  values (p_sim, p_track_id, p_config_id, 1, jsonb_set(p_data, '{trackRef,mapVersion}', '1'), auth.uid());
  return query select 1, true;
end;
$$;

revoke all on function public.submit_map from public, anon;
grant execute on function public.submit_map to authenticated;
