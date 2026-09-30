-- Content: callout packs now, themes in M9 — TODO.md M8 steps 3-7.
--
-- One table with a `kind` rather than `packs`, so M9 adds a value instead of a
-- second copy of versions, stars, downloads and reports.
--
-- The rules that matter, and where each is enforced:
--   * A published version is immutable        → no table grants; publish_version() only.
--   * Version numbers are 1, 2, 3 per item     → assigned under a row lock in publish_version().
--   * No dirty note is ever published          → checked in publish_version().
--   * Counters cannot be written by clients    → column grants + triggers/RPC.
--   * Drafts are the owner's alone             → RLS on content_drafts.

create table public.content_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('callouts', 'theme')),
  owner uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 3 and 80),
  summary text not null default '' check (char_length(summary) <= 160),
  readme text not null default '' check (char_length(readme) <= 50000),
  icon_path text,
  -- private: only the owner sees it. unlisted: anyone with the link, not in
  -- search. public: listed.
  visibility text not null default 'private' check (visibility in ('private', 'unlisted', 'public')),
  -- Set by an admin (M8 step 7). Hidden from everyone but the owner and admins.
  removed boolean not null default false,
  sim text,
  track_id integer,
  config_id text,
  car_class text,
  -- Denormalised from track_layouts for search and for the list row.
  track_label text not null default '',
  star_count integer not null default 0,
  download_count integer not null default 0,
  latest_version integer,
  latest_version_id uuid,
  based_on_version_id uuid,
  search tsvector generated always as (
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('simple', track_label), 'A') ||
    setweight(to_tsvector('simple', summary), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (sim, track_id, config_id) references public.track_layouts (sim, track_id, config_id),
  -- Callout packs are about a layout; themes are about nothing in particular.
  check (kind <> 'callouts' or (sim is not null and track_id is not null and config_id is not null))
);

create table public.content_versions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.content_items (id) on delete cascade,
  version integer not null check (version >= 1),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) < 1000000),
  map_version integer,
  voice_id text,
  changelog text not null default '' check (char_length(changelog) <= 500),
  -- The app's own note-by-note diff against the previous version (Step 3b).
  diff jsonb,
  download_count integer not null default 0,
  published_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  unique (item_id, version)
);

alter table public.content_items
  add foreign key (latest_version_id) references public.content_versions (id) on delete set null,
  add foreign key (based_on_version_id) references public.content_versions (id) on delete set null;

create table public.content_drafts (
  item_id uuid primary key references public.content_items (id) on delete cascade,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) < 1000000),
  updated_at timestamptz not null default now()
);

create table public.content_media (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.content_items (id) on delete cascade,
  kind text not null check (kind in ('icon', 'screenshot')),
  path text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.content_setups (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.content_versions (id) on delete cascade,
  path text not null,
  label text not null check (char_length(label) between 1 and 60),
  car_id text,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer not null check (bytes > 0)
);

create table public.stars (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  item_id uuid not null references public.content_items (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

-- One row per installation per version, so reinstalling in a loop counts once.
-- installation_id is a random uuid the app makes on first run, which lets
-- signed-out installs count too.
create table public.downloads (
  id bigint generated always as identity primary key,
  version_id uuid not null references public.content_versions (id) on delete cascade,
  installation_id uuid not null,
  user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (version_id, installation_id)
);

create table public.reports (
  id bigint generated always as identity primary key,
  reporter uuid not null default auth.uid() references auth.users (id) on delete cascade,
  target_kind text not null check (target_kind in ('content', 'map', 'setup')),
  target_id text not null check (char_length(target_id) <= 200),
  reason text not null check (reason in ('wrong', 'offensive', 'copyright', 'spam', 'other')),
  details text not null default '' check (char_length(details) <= 2000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text
);

create index content_items_search on public.content_items using gin (search);
create index content_items_listed_stars on public.content_items (star_count desc)
  where visibility = 'public' and not removed and latest_version is not null;
create index content_items_listed_downloads on public.content_items (download_count desc)
  where visibility = 'public' and not removed and latest_version is not null;
create index content_items_listed_updated on public.content_items (updated_at desc)
  where visibility = 'public' and not removed and latest_version is not null;
create index content_items_combo on public.content_items (sim, track_id, config_id, car_class);
create index content_items_owner on public.content_items (owner);
create index content_versions_item on public.content_versions (item_id, version desc);
create index content_media_item on public.content_media (item_id, position);
create index content_setups_version on public.content_setups (version_id);
create index stars_item on public.stars (item_id);

-- ---------------------------------------------------------------------------
-- Grants and policies
-- ---------------------------------------------------------------------------

alter table public.content_items enable row level security;
alter table public.content_versions enable row level security;
alter table public.content_drafts enable row level security;
alter table public.content_media enable row level security;
alter table public.content_setups enable row level security;
alter table public.stars enable row level security;
alter table public.downloads enable row level security;
alter table public.reports enable row level security;

revoke all on public.content_items, public.content_versions, public.content_drafts,
  public.content_media, public.content_setups, public.stars, public.downloads, public.reports
  from anon, authenticated;

grant select on public.content_items, public.content_versions, public.content_media,
  public.content_setups, public.stars to anon, authenticated;

-- Only the columns an author edits. Counters, latest_*, owner and removed are
-- written by triggers and RPCs, never by a client.
grant insert (kind, title, summary, readme, icon_path, visibility, sim, track_id, config_id, car_class, based_on_version_id)
  on public.content_items to authenticated;
grant update (title, summary, readme, icon_path, visibility, car_class)
  on public.content_items to authenticated;
grant delete on public.content_items to authenticated;

grant select, insert, update, delete on public.content_drafts to authenticated;
grant insert (item_id, kind, path, position), delete on public.content_media to authenticated;
grant insert (item_id), delete on public.stars to authenticated;
grant insert (target_kind, target_id, reason, details) on public.reports to authenticated;
grant select on public.reports to authenticated;
grant update (resolved_at, resolution) on public.reports to authenticated;

-- Visible: listed or unlisted, published, not removed — or yours, or you are an admin.
create policy "visible items" on public.content_items for select using (
  (visibility in ('public', 'unlisted') and not removed and latest_version is not null)
  or owner = (select auth.uid())
  or (select public.is_admin())
);
create policy "create your own items" on public.content_items for insert to authenticated
  with check (owner = (select auth.uid()));
create policy "edit your own items" on public.content_items for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
-- Deleting is for things never published. A published item has installs
-- pinned to it; the way out is visibility = 'private'.
create policy "delete your own unpublished items" on public.content_items for delete to authenticated
  using (owner = (select auth.uid()) and latest_version is null);

-- Versions, media and setups follow their item's visibility: the subquery runs
-- under the caller's own RLS on content_items.
create policy "versions of visible items" on public.content_versions for select using (
  exists (select 1 from public.content_items i where i.id = item_id)
);
create policy "media of visible items" on public.content_media for select using (
  exists (select 1 from public.content_items i where i.id = item_id)
);
create policy "add media to your own items" on public.content_media for insert to authenticated with check (
  exists (select 1 from public.content_items i where i.id = item_id and i.owner = (select auth.uid()))
  and path like 'items/' || item_id::text || '/%'
);
create policy "remove media from your own items" on public.content_media for delete to authenticated using (
  exists (select 1 from public.content_items i where i.id = item_id and i.owner = (select auth.uid()))
);
create policy "setups of visible versions" on public.content_setups for select using (
  exists (select 1 from public.content_versions v where v.id = version_id)
);

create policy "your own drafts" on public.content_drafts for all to authenticated
  using (exists (select 1 from public.content_items i where i.id = item_id and i.owner = (select auth.uid())))
  with check (exists (select 1 from public.content_items i where i.id = item_id and i.owner = (select auth.uid())));

-- Stargazers are public, as on GitHub.
create policy "stars are public" on public.stars for select using (true);
create policy "star what you can see" on public.stars for insert to authenticated with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.content_items i
    where i.id = item_id and i.visibility in ('public', 'unlisted') and not i.removed and i.latest_version is not null
  )
);
create policy "unstar your own" on public.stars for delete to authenticated
  using (user_id = (select auth.uid()));

-- downloads: no client access at all; record_download() writes, counters show.

create policy "file a report" on public.reports for insert to authenticated
  with check (reporter = (select auth.uid()));
create policy "see your own reports, or all as admin" on public.reports for select to authenticated
  using (reporter = (select auth.uid()) or (select public.is_admin()));
create policy "admins resolve reports" on public.reports for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create function public.content_items_before_write() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.sim is not null then
    select l.track_name || case when l.config_name = '' then '' else ' ' || l.config_name end
      into new.track_label
    from public.track_layouts l
    where l.sim = new.sim and l.track_id = new.track_id and l.config_id = new.config_id;
    new.track_label := coalesce(new.track_label, '');
  end if;
  return new;
end;
$$;

create trigger content_items_before_write
  before insert or update of title, summary, readme, icon_path, visibility, car_class, sim, track_id, config_id
  on public.content_items
  for each row execute function public.content_items_before_write();

create function public.stars_count() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.content_items set star_count = star_count + 1 where id = new.item_id;
  else
    update public.content_items set star_count = greatest(star_count - 1, 0) where id = old.item_id;
  end if;
  return null;
end;
$$;

create trigger stars_count
  after insert or delete on public.stars
  for each row execute function public.stars_count();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Publish the next version of an item you own. p_setups is an array of
-- {path, label, car_id, sha256, bytes} for files already uploaded to the
-- setups bucket under items/<item_id>/.
create function public.publish_version(
  p_item_id uuid,
  p_payload jsonb,
  p_changelog text default '',
  p_diff jsonb default null,
  p_map_version integer default null,
  p_voice_id text default null,
  p_setups jsonb default '[]'::jsonb
) returns public.content_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  item public.content_items;
  next_version integer;
  published public.content_versions;
  setup jsonb;
begin
  select * into item from public.content_items where id = p_item_id for update;
  if item.id is null or item.owner is distinct from auth.uid() then
    raise exception 'not your item' using errcode = '42501';
  end if;

  if item.kind = 'callouts' then
    if jsonb_typeof(p_payload -> 'notes') is distinct from 'array' then
      raise exception 'a callout pack needs a notes array';
    end if;
    -- A dirty note's audio no longer matches its words, so its timing is
    -- wrong for everyone who installs it (SPEC §7.4).
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

  select coalesce(max(version), 0) + 1 into next_version
  from public.content_versions where item_id = p_item_id;

  insert into public.content_versions (item_id, version, payload, map_version, voice_id, changelog, diff)
  values (p_item_id, next_version, p_payload, p_map_version, p_voice_id, left(coalesce(p_changelog, ''), 500), p_diff)
  returning * into published;

  for setup in select * from jsonb_array_elements(coalesce(p_setups, '[]'::jsonb)) loop
    if (setup ->> 'path') not like 'items/' || p_item_id::text || '/%' then
      raise exception 'setup file is not in this item''s folder';
    end if;
    insert into public.content_setups (version_id, path, label, car_id, sha256, bytes)
    values (published.id, setup ->> 'path', setup ->> 'label', setup ->> 'car_id', setup ->> 'sha256', (setup ->> 'bytes')::integer);
  end loop;

  update public.content_items
    set latest_version = next_version, latest_version_id = published.id, updated_at = now()
    where id = p_item_id;

  return published;
end;
$$;

-- Hide a version from new installs. Not deleted: pinned installs keep it.
create function public.withdraw_version(p_version_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.content_versions;
  newest public.content_versions;
begin
  select v.* into target
  from public.content_versions v join public.content_items i on i.id = v.item_id
  where v.id = p_version_id and i.owner = auth.uid()
  for update of i;
  if target.id is null then
    raise exception 'not your version' using errcode = '42501';
  end if;

  update public.content_versions set withdrawn_at = now() where id = p_version_id and withdrawn_at is null;

  select * into newest from public.content_versions
  where item_id = target.item_id and withdrawn_at is null
  order by version desc limit 1;

  update public.content_items
    set latest_version = newest.version, latest_version_id = newest.id, updated_at = now()
    where id = target.item_id;
end;
$$;

-- Count an install. Callable signed out: installation_id identifies the copy
-- of the app, and the unique constraint makes repeats free.
create function public.record_download(p_version_id uuid, p_installation_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_item uuid;
  inserted integer;
begin
  select v.item_id into target_item
  from public.content_versions v join public.content_items i on i.id = v.item_id
  where v.id = p_version_id and v.withdrawn_at is null
    and i.visibility in ('public', 'unlisted') and not i.removed;
  if target_item is null then
    return;
  end if;

  insert into public.downloads (version_id, installation_id, user_id)
  values (p_version_id, p_installation_id, auth.uid())
  on conflict do nothing;
  get diagnostics inserted = row_count;

  if inserted > 0 then
    update public.content_versions set download_count = download_count + 1 where id = p_version_id;
    update public.content_items set download_count = download_count + 1 where id = target_item;
  end if;
end;
$$;

-- Moderation (M8 step 7).
create function public.set_item_removed(p_item_id uuid, p_removed boolean) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;
  update public.content_items set removed = p_removed where id = p_item_id;
end;
$$;

revoke all on function public.publish_version, public.withdraw_version, public.record_download,
  public.set_item_removed, public.content_items_before_write, public.stars_count from public, anon;
grant execute on function public.publish_version, public.withdraw_version, public.set_item_removed to authenticated;
grant execute on function public.record_download to anon, authenticated;
