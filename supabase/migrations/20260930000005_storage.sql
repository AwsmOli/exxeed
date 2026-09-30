-- Storage policies — TODO.md M8 steps 5-6. Buckets are declared in config.toml.
--
-- content-media: items/<item_id>/<file> for icons and screenshots, and
--   avatars/<user_id>/<file>. Public read (the bucket is public); writes only
--   into your own item's or your own avatar's folder.
-- setups: items/<item_id>/<sha256>.sto. Readable by the owner, and by anyone
--   once a visible version lists the file; writes only into your own item.

create function public.owns_item_folder(object_name text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (storage.foldername(object_name))[1] = 'items'
     and exists (
       select 1 from public.content_items i
       where i.id::text = (storage.foldername(object_name))[2] and i.owner = (select auth.uid())
     );
$$;

grant execute on function public.owns_item_folder to authenticated;

create policy "content media: owners upload" on storage.objects for insert to authenticated with check (
  bucket_id = 'content-media' and (
    public.owns_item_folder(name)
    or ((storage.foldername(name))[1] = 'avatars' and (storage.foldername(name))[2] = (select auth.uid())::text)
  )
);
create policy "content media: owners replace" on storage.objects for update to authenticated using (
  bucket_id = 'content-media' and (
    public.owns_item_folder(name)
    or ((storage.foldername(name))[1] = 'avatars' and (storage.foldername(name))[2] = (select auth.uid())::text)
  )
);
create policy "content media: owners delete" on storage.objects for delete to authenticated using (
  bucket_id = 'content-media' and (
    public.owns_item_folder(name)
    or ((storage.foldername(name))[1] = 'avatars' and (storage.foldername(name))[2] = (select auth.uid())::text)
  )
);

create policy "setups: owners upload" on storage.objects for insert to authenticated with check (
  bucket_id = 'setups' and public.owns_item_folder(name)
);
create policy "setups: owners delete" on storage.objects for delete to authenticated using (
  bucket_id = 'setups' and public.owns_item_folder(name)
);
-- content_setups' own RLS already limits rows to visible versions, so this
-- subquery is "is this file part of something the caller may see".
create policy "setups: readable when published" on storage.objects for select using (
  bucket_id = 'setups' and (
    public.owns_item_folder(name)
    or exists (select 1 from public.content_setups s where s.path = name)
  )
);
