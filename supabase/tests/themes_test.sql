-- Themes as content (M9 step 3). Run with `pnpm db:test`.
--
-- A theme is a content item with no track, whose published payload is a theme
-- file instead of a note set. The server stores it as given; the app
-- validates it on install.

begin;
create extension if not exists pgtap with schema extensions;

select plan(7);

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000a11c', 'alice@example.test', '{"full_name": "Alice Driver"}'),
  ('00000000-0000-0000-0000-0000000000b0', 'bob@example.test', '{}');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a11c", "role": "authenticated"}';

select lives_ok(
  $$ insert into public.content_items (kind, title, summary, visibility)
     values ('theme', 'Night shift', 'Dark and quiet', 'public') $$,
  'a signed-in driver can create a theme, which has no track'
);

select is(
  (select version from public.publish_version(
     (select id from public.content_items where title = 'Night shift'),
     '{"name": "Night shift", "base": "exxeed", "tokens": {"card": "#101010"}}'::jsonb,
     'First version', null, null, null, '[]'::jsonb)),
  1,
  'a theme publishes without notes, a map version or a voice'
);

select is(
  (select payload -> 'tokens' ->> 'card' from public.content_versions v
     join public.content_items i on i.id = v.item_id where i.title = 'Night shift'),
  '#101010',
  'the payload is stored as it was given'
);

select is(
  (select latest_version from public.content_items where title = 'Night shift'),
  1,
  'the item points at its latest version'
);

-- Bob
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b0", "role": "authenticated"}';

select is(
  (select count(*)::int from public.content_items where kind = 'theme' and title = 'Night shift'),
  1,
  'another driver can see a public theme'
);

select throws_ok(
  $$ select public.publish_version(
       (select id from public.content_items where title = 'Night shift'),
       '{"name": "Hijacked"}'::jsonb, '', null, null, null, '[]'::jsonb) $$,
  '42501', null,
  'but cannot publish a version of it'
);

select lives_ok(
  $$ insert into public.stars (item_id) select id from public.content_items where title = 'Night shift' $$,
  'and can star it, like a callout pack'
);

select * from finish();
rollback;
