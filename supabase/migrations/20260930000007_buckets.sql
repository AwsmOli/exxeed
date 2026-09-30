-- Storage buckets, as a migration so the hosted project gets them too.
-- config.toml declares the same two for the local stack; `on conflict` keeps
-- the two sources from fighting, and this file is the one that wins.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  -- Icons and screenshots for Content pages: public read, re-encoded by the app
  -- before upload (strips EXIF).
  ('content-media', 'content-media', true, 4 * 1024 * 1024, array['image/png', 'image/jpeg', 'image/webp']),
  -- iRacing .sto setups: private, readable through policies once published.
  ('setups', 'setups', false, 512 * 1024, array['application/octet-stream'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
