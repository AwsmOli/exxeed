-- RLS and RPC rules for M8. Run with `pnpm db:test`.
--
-- Each block switches to a role and a user the way PostgREST would, so these
-- exercise the same policies a client hits. Everything rolls back at the end.

begin;
create extension if not exists pgtap with schema extensions;

select plan(29);

-- Two drivers. The trigger makes their profiles.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000a11c', 'alice@example.test', '{"full_name": "Alice Driver"}'),
  ('00000000-0000-0000-0000-0000000000b0', 'bob@example.test', '{}');

select is(
  (select display_name from public.profiles where id = '00000000-0000-0000-0000-00000000a11c'),
  'Alice Driver',
  'a profile is created on sign-up, named from the provider'
);
select is(
  (select display_name from public.profiles where id = '00000000-0000-0000-0000-0000000000b0'),
  'bob',
  'with no provider name, the email''s local part'
);

-- ---------------------------------------------------------------------------
-- Alice
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a11c", "role": "authenticated"}';

select throws_ok(
  $$ update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-00000000a11c' $$,
  '42501', null,
  'nobody can make themselves an admin'
);

select lives_ok(
  $$ insert into public.content_items (kind, title, sim, track_id, config_id, car_class)
     values ('callouts', 'Daytona in the MX-5', 'iracing', 192, 'road-course', 'mx5') $$,
  'a signed-in driver can create an item'
);

select is(
  (select track_label from public.content_items where title = 'Daytona in the MX-5'),
  'Daytona International Speedway Road Course',
  'the track label is filled in from the catalog, for search'
);

select throws_ok(
  $$ insert into public.content_items (kind, title, sim, track_id, config_id, owner)
     values ('callouts', 'Pretending to be Bob', 'iracing', 192, 'road-course', '00000000-0000-0000-0000-0000000000b0') $$,
  '42501', null,
  'the owner cannot be set by the client'
);

select lives_ok(
  $$ insert into public.content_drafts (item_id, payload)
     select id, '{"notes": []}'::jsonb from public.content_items where title = 'Daytona in the MX-5' $$,
  'the owner can save a draft'
);

select throws_ok(
  $$ select public.publish_version(
       (select id from public.content_items where title = 'Daytona in the MX-5'),
       '{"trackKey": {"sim": "iracing", "trackId": 192, "configId": "road-course"},
         "notes": [{"id": "abc123", "dirty": true}]}'::jsonb) $$,
  'P0001', 'render the audio first: some callouts have changed since it was rendered',
  'a version with a dirty note is refused'
);

select throws_ok(
  $$ select public.publish_version(
       (select id from public.content_items where title = 'Daytona in the MX-5'),
       '{"trackKey": {"sim": "iracing", "trackId": 297, "configId": "300-circuit"}, "notes": []}'::jsonb) $$,
  'P0001', 'the note set is for a different track than this item',
  'a note set for another track is refused'
);

select is(
  (select version from public.publish_version(
     (select id from public.content_items where title = 'Daytona in the MX-5'),
     '{"trackKey": {"sim": "iracing", "trackId": 192, "configId": "road-course"},
       "notes": [{"id": "abc123", "dirty": false}]}'::jsonb, 'first version')),
  1,
  'the first version is v1'
);

select is(
  (select version from public.publish_version(
     (select id from public.content_items where title = 'Daytona in the MX-5'),
     '{"trackKey": {"sim": "iracing", "trackId": 192, "configId": "road-course"},
       "notes": [{"id": "abc123", "dirty": false}, {"id": "def456", "dirty": false}]}'::jsonb, 'added one')),
  2,
  'the next is v2'
);

select throws_ok(
  $$ update public.content_versions set changelog = 'rewritten history' $$,
  '42501', null,
  'a published version cannot be edited, even by its author'
);

select throws_ok(
  $$ update public.content_items set star_count = 1000 where title = 'Daytona in the MX-5' $$,
  '42501', null,
  'counters cannot be written by a client'
);

-- Deletes are filtered by RLS rather than refused: try, then check it is still there.
delete from public.content_items where title = 'Daytona in the MX-5';
select is(
  (select count(*)::int from public.content_items where title = 'Daytona in the MX-5'),
  1,
  'a published item cannot be deleted, only made private'
);

-- ---------------------------------------------------------------------------
-- Bob, before Alice makes it public
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b0", "role": "authenticated"}';

select is(
  (select count(*)::int from public.content_items where title = 'Daytona in the MX-5'),
  0,
  'a private item is invisible to other drivers'
);
select is(
  (select count(*)::int from public.content_drafts),
  0,
  'another driver''s draft is invisible'
);
select is(
  (select count(*)::int from public.content_versions),
  0,
  'and so are its versions'
);

-- ---------------------------------------------------------------------------
-- Alice publishes it
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a11c", "role": "authenticated"}';
update public.content_items set visibility = 'public' where title = 'Daytona in the MX-5';

-- ---------------------------------------------------------------------------
-- Bob again
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b0", "role": "authenticated"}';

select is(
  (select count(*)::int from public.content_items where title = 'Daytona in the MX-5'),
  1,
  'a public item is visible'
);
select is(
  (select count(*)::int from public.content_drafts),
  0,
  'its draft still is not'
);

insert into public.stars (item_id) select id from public.content_items where title = 'Daytona in the MX-5';
select is(
  (select star_count from public.content_items where title = 'Daytona in the MX-5'),
  1,
  'starring counts'
);
select throws_ok(
  $$ insert into public.stars (item_id) select id from public.content_items where title = 'Daytona in the MX-5' $$,
  '23505', null,
  'one star per driver'
);
delete from public.stars where item_id = (select id from public.content_items where title = 'Daytona in the MX-5');
select is(
  (select star_count from public.content_items where title = 'Daytona in the MX-5'),
  0,
  'un-starring un-counts'
);

select throws_ok(
  $$ select public.withdraw_version((select latest_version_id from public.content_items where title = 'Daytona in the MX-5')) $$,
  '42501', null,
  'only the author can withdraw a version'
);

select is(
  (select row(map_version, accepted)::text from public.submit_map('iracing', 192, 'road-course',
    '{"trackRef": {"sim": "iracing", "trackId": 192, "configId": "road-course"}, "corners": []}'::jsonb)),
  '(1,t)',
  'the first map for a layout becomes v1, and is accepted'
);

-- ---------------------------------------------------------------------------
-- Signed out
-- ---------------------------------------------------------------------------
set local role anon;
set local request.jwt.claims = '{"role": "anon"}';

select public.record_download(
  (select latest_version_id from public.content_items where title = 'Daytona in the MX-5'),
  '00000000-0000-0000-0000-00000000cafe');
select public.record_download(
  (select latest_version_id from public.content_items where title = 'Daytona in the MX-5'),
  '00000000-0000-0000-0000-00000000cafe');
select is(
  (select download_count from public.content_items where title = 'Daytona in the MX-5'),
  1,
  'a download counts once per installation, even signed out'
);

select throws_ok(
  $$ select public.submit_map('iracing', 297, '300-circuit',
       '{"trackRef": {"sim": "iracing", "trackId": 297, "configId": "300-circuit"}, "corners": []}'::jsonb) $$,
  '42501', null,
  'sharing a map needs an account'
);

-- ---------------------------------------------------------------------------
-- Alice, again: first map wins, withdrawing moves latest back
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a11c", "role": "authenticated"}';

select is(
  (select row(map_version, accepted)::text from public.submit_map('iracing', 192, 'road-course',
    '{"trackRef": {"sim": "iracing", "trackId": 192, "configId": "road-course"}, "corners": [{"index": 1}]}'::jsonb)),
  '(1,f)',
  'a second map for the same layout is not accepted, and v1 stands'
);
select is(
  (select created_by from public.track_maps where track_id = 192),
  '00000000-0000-0000-0000-0000000000b0'::uuid,
  'and does not replace it'
);

select public.withdraw_version((select latest_version_id from public.content_items where title = 'Daytona in the MX-5'));
select is(
  (select latest_version from public.content_items where title = 'Daytona in the MX-5'),
  1,
  'withdrawing the newest version makes the previous one latest'
);

select * from finish();
rollback;
