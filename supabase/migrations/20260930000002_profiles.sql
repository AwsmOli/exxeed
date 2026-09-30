-- Profiles: the public face of an account — TODO.md M8 step 1.
--
-- A display name and an avatar, and nothing else about a person is public.
-- Created by trigger on sign-up with a name guessed from the provider, then
-- confirmed by the person on first sign-in (`onboarded`).

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 40),
  avatar_path text,
  role text not null default 'user' check (role in ('user', 'admin')),
  onboarded boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to anon, authenticated;
-- Column grants, not just a policy: RLS decides which rows, grants decide which
-- columns. Without this, "update your own row" would include `role`.
grant update (display_name, avatar_path, onboarded) on public.profiles to authenticated;

create policy "profiles are public" on public.profiles for select using (true);
create policy "update your own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create function public.is_admin() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'
  );
$$;

grant execute on function public.is_admin to anon, authenticated;

create function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  guess text;
begin
  guess := coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    new.raw_user_meta_data ->> 'user_name',
    split_part(coalesce(new.email, ''), '@', 1)
  );
  guess := left(trim(coalesce(guess, '')), 40);
  if char_length(guess) < 2 then
    guess := 'Driver ' || left(new.id::text, 6);
  end if;

  insert into public.profiles (id, display_name) values (new.id, guess);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
