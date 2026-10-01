-- Files attached to a pack version: setups and iRacing lap files — TODO.md M8
-- step 6.
--
-- content_setups becomes content_files with a kind. Policies and the storage
-- policy that reads it follow the rename on their own (they reference the
-- table, not its name). The bucket keeps the name `setups`; it holds every
-- kind of attachment now.

alter table public.content_setups rename to content_files;
alter index public.content_setups_version rename to content_files_version;

alter table public.content_files
  add column kind text not null default 'setup' check (kind in ('setup', 'blap', 'olap'));
alter table public.content_files alter column kind drop default;

-- publish_version takes files of any kind. p_setups becomes p_files; each
-- entry is {kind, path, label, car_id, sha256, bytes} for a file already
-- uploaded under items/<item_id>/.
drop function public.publish_version(uuid, jsonb, text, jsonb, integer, text, jsonb);

create function public.publish_version(
  p_item_id uuid,
  p_payload jsonb,
  p_changelog text default '',
  p_diff jsonb default null,
  p_map_version integer default null,
  p_voice_id text default null,
  p_files jsonb default '[]'::jsonb
) returns public.content_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  item public.content_items;
  next_version integer;
  published public.content_versions;
  file jsonb;
begin
  select * into item from public.content_items where id = p_item_id for update;
  if item.id is null or item.owner is distinct from auth.uid() then
    raise exception 'not your item' using errcode = '42501';
  end if;

  if item.kind = 'callouts' then
    if jsonb_typeof(p_payload -> 'notes') is distinct from 'array' then
      raise exception 'a callout pack needs a notes array';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_payload -> 'notes') n
      where coalesce((n ->> 'dirty')::boolean, false)
    ) then
      raise exception 'render the audio first: some callouts have changed since it was rendered';
    end if;
    if p_payload -> 'trackKey' ->> 'sim' is distinct from item.sim
       or (p_payload -> 'trackKey' ->> 'trackId')::integer is distinct from item.track_id
       or p_payload -> 'trackKey' ->> 'configId' is distinct from item.config_id then
      raise exception 'the note set is for a different track than this item';
    end if;
  end if;

  if jsonb_array_length(coalesce(p_files, '[]'::jsonb)) > 20 then
    raise exception 'at most 20 files per version';
  end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.content_versions where item_id = p_item_id;

  insert into public.content_versions (item_id, version, payload, map_version, voice_id, changelog, diff)
  values (p_item_id, next_version, p_payload, p_map_version, p_voice_id, left(coalesce(p_changelog, ''), 500), p_diff)
  returning * into published;

  for file in select * from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) loop
    if (file ->> 'path') not like 'items/' || p_item_id::text || '/%' then
      raise exception 'a file is not in this item''s folder';
    end if;
    insert into public.content_files (version_id, kind, path, label, car_id, sha256, bytes)
    values (
      published.id,
      coalesce(file ->> 'kind', 'setup'),
      file ->> 'path',
      file ->> 'label',
      file ->> 'car_id',
      file ->> 'sha256',
      (file ->> 'bytes')::integer
    );
  end loop;

  update public.content_items
    set latest_version = next_version, latest_version_id = published.id, updated_at = now()
    where id = p_item_id;

  return published;
end;
$$;

revoke all on function public.publish_version from public, anon;
grant execute on function public.publish_version to authenticated;
