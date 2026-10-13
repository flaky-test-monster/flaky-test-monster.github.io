-- The jury vote on the music page (public/music.html), as at the Eurovision Song Contest:
-- each jury gives 12, 10, 8, 7 and down to 1 points, each score to one song only.
--
-- The page is static and talks to Supabase with the public anon key, so nothing here trusts
-- the browser:
--   * Every voter is a Supabase user, an anonymous one by default (Authentication → Sign In /
--     Providers → Allow anonymous sign-ins). A user has one ballot, and it is final: once cast,
--     it cannot be changed, so nobody can move their points after peeking at the scoreboard.
--   * The tables have row level security on and no policies, and anon and authenticated
--     have no rights on them: the page cannot read or write a row directly.
--   * All access goes through functions: cast_ballot checks every vote before it is stored,
--     my_ballot returns the caller's own ballot only, and scoreboard returns the totals only,
--     never who gave what, nor the jury names people typed in.
--   * The admin page (public/music-admin.html) lists, adds and deletes ballots through the
--     admin_* functions. Each one first checks that the caller is an admin: a signed-in,
--     non-anonymous user listed in public.admins. Signing in is not enough, as every voter
--     is signed in too; only someone with the SQL editor can add an admin:
--       insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
--   * The country a ballot comes from is taken from the request, never from the browser's
--     data: Supabase sits behind Cloudflare, which names the caller's country in the
--     CF-IPCountry header. Only the two-letter code is kept, not the IP address. Without the
--     header, the country is null. To check that it arrives once people vote:
--       select country, count(*) from public.ballots group by country;
--
-- Run it once in the SQL editor of your Supabase project, or with `supabase db push`.
-- It can be run again: the songs are upserted and the functions replaced.

create table if not exists public.songs (
  -- The data-song attribute of the song's list item on the music page.
  id text primary key check (id ~ '^[a-z0-9-]{1,40}$'),
  title text not null,
  position smallint not null unique
);

-- One row: whether voting is open. To close it: update public.contest set open = false;
create table if not exists public.contest (
  id boolean primary key default true check (id),
  open boolean not null default true
);
insert into public.contest (id) values (true) on conflict (id) do nothing;

create table if not exists public.ballots (
  -- The voter's user id for a ballot cast online; a new id for one an admin added.
  voter uuid primary key,
  jury text not null default '' check (char_length(jury) <= 60),
  created_at timestamptz not null default now(),
  -- ISO 3166 code from CF-IPCountry, such as AT; null when unknown.
  country text check (country ~ '^[A-Z]{2}$'),
  -- online: cast on the music page; admin: added on the admin page, say from an email.
  source text not null default 'online' check (source in ('online', 'admin'))
);
-- For projects that ran this file before the country was kept, and before admins could add
-- ballots: those have no user of their own, so the voter no longer has to be one.
alter table public.ballots add column if not exists country text check (country ~ '^[A-Z]{2}$');
alter table public.ballots add column if not exists source text not null default 'online' check (source in ('online', 'admin'));
alter table public.ballots drop constraint if exists ballots_voter_fkey;

-- The admins: users who may use the admin page. Only added from the SQL editor (see above).
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.votes (
  voter uuid not null references public.ballots (voter) on delete cascade,
  song text not null references public.songs (id) on delete cascade,
  points smallint not null check (points in (1, 2, 3, 4, 5, 6, 7, 8, 10, 12)),
  primary key (voter, song),
  -- Each score to one song only.
  unique (voter, points)
);
create index if not exists votes_song on public.votes (song);

alter table public.songs enable row level security;
alter table public.contest enable row level security;
alter table public.ballots enable row level security;
alter table public.votes enable row level security;
alter table public.admins enable row level security;
revoke all on table public.songs, public.contest, public.ballots, public.votes, public.admins from public, anon, authenticated;

-- The songs, in the order of the music page. Keep the ids in step with its data-song attributes.
insert into public.songs (id, title, position) values
  ('international', 'From Flaky With Love: the international version', 1),
  ('greek', 'The Greek version', 2),
  ('austrian', 'The Austrian version', 3),
  ('klingon', 'The Klingon version', 4),
  ('spanish', 'The Spanish version', 5),
  ('italian', 'The Italian version', 6),
  ('polish', 'The Polish version', 7),
  ('french', 'The French version', 8),
  ('cat', 'The cat version', 9)
on conflict (id) do update set title = excluded.title, position = excluded.position;

-- Checks a ballot, for voters and admins alike, and returns the jury name tidied up. votes is
-- an object of song id to points, such as {"klingon": 12, "greek": 10}. Errors raised here
-- (SQLSTATE P0001) are meant for the voter. Not for the browser: only the functions below use it.
create or replace function public.checked_jury(jury text, votes jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  clean_jury text;
begin
  if votes is null or jsonb_typeof(votes) <> 'object' or votes = '{}'::jsonb then
    raise exception 'Give at least one song some points.';
  end if;
  -- Oversized input is turned away before any work is done on it.
  if (select count(*) from jsonb_object_keys(votes)) > 10 then
    raise exception 'Points are 12, 10, 8, 7, 6, 5, 4, 3, 2 or 1, each to one song only.';
  end if;
  if char_length(jury) > 200 then
    raise exception 'The jury name is too long: 60 characters at most.';
  end if;
  clean_jury := btrim(regexp_replace(coalesce(jury, ''), '[[:cntrl:][:space:]]+', ' ', 'g'));
  if char_length(clean_jury) > 60 then
    raise exception 'The jury name is too long: 60 characters at most.';
  end if;
  if exists (
    select 1 from jsonb_each(votes) v
    where jsonb_typeof(v.value) <> 'number'
      or (v.value #>> '{}') not in ('1', '2', '3', '4', '5', '6', '7', '8', '10', '12')
  ) then
    raise exception 'Points are 12, 10, 8, 7, 6, 5, 4, 3, 2 or 1.';
  end if;
  if exists (select 1 from jsonb_object_keys(votes) k where k not in (select s.id from public.songs s)) then
    raise exception 'One of the songs is not in the contest.';
  end if;
  if (select count(distinct v.value) <> count(*) from jsonb_each(votes) v) then
    raise exception 'Each score goes to one song only.';
  end if;
  return clean_jury;
end;
$$;

-- Casts the caller's ballot, once: a second one is turned away. The one error for a second
-- ballot carries the hint already_voted.
create or replace function public.cast_ballot(jury text, votes jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  clean_jury text;
  -- PostgREST hands the request headers over as JSON, with lower-case names.
  country text := upper(nullif(current_setting('request.headers', true), '')::json ->> 'cf-ipcountry');
begin
  if me is null then
    raise exception 'Sign in to vote.' using errcode = '28000';
  end if;
  if not (select c.open from public.contest c) then
    raise exception 'Voting is closed.';
  end if;
  clean_jury := public.checked_jury(jury, votes);

  -- XX is Cloudflare's "unknown" and T1 is Tor: neither is a country.
  if country !~ '^[A-Z]{2}$' or country in ('XX', 'T1') then
    country := null;
  end if;

  -- One ballot per voter, and it is final. The insert itself decides, so two casts at the same
  -- moment cannot both get in.
  insert into public.ballots (voter, jury, country) values (me, clean_jury, country)
  on conflict (voter) do nothing;
  if not found then
    raise exception 'You have already voted, and votes are final.' using hint = 'already_voted';
  end if;
  insert into public.votes (voter, song, points)
  select me, v.key, (v.value #>> '{}')::smallint from jsonb_each(votes) v;
end;
$$;

-- The caller's own ballot, {"jury": "...", "votes": {"klingon": 12, ...}}, or null.
create or replace function public.my_ballot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'jury', b.jury,
    'votes', coalesce((select jsonb_object_agg(v.song, v.points) from public.votes v where v.voter = b.voter), '{}'::jsonb)
  )
  from public.ballots b
  where b.voter = auth.uid();
$$;

-- The totals for everyone to see: how many juries voted, from how many countries (a count only,
-- so no lone voter from a small country stands out), whether voting is open, and for each
-- song its points, how many juries gave it points and how many gave it 12. Highest first.
create or replace function public.scoreboard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'juries', (select count(*) from public.ballots),
    'countries', (select count(distinct b.country) from public.ballots b),
    'open', (select c.open from public.contest c),
    'songs', coalesce(jsonb_agg(jsonb_build_object(
      'song', t.id, 'points', t.points, 'juries', t.juries, 'twelves', t.twelves
    ) order by t.points desc, t.twelves desc, t.position), '[]'::jsonb)
  )
  from (
    select s.id, s.position,
      coalesce(sum(v.points), 0) as points,
      count(v.points) as juries,
      count(v.points) filter (where v.points = 12) as twelves
    from public.songs s
    left join public.votes v on v.song = s.id
    group by s.id, s.position
  ) t;
$$;

-- Whether the caller is an admin: signed in with an account of their own, not anonymously,
-- and listed in public.admins.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    and exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

-- Stops any admin function called by someone who is not an admin.
create or replace function public.require_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
end;
$$;

-- For the admin page: whether voting is open, the songs, and every ballot with its points,
-- newest first. The jury names are the ones people typed: the page shows them as text only.
create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  return jsonb_build_object(
    'open', (select c.open from public.contest c),
    'songs', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title) order by s.position), '[]'::jsonb) from public.songs s),
    'ballots', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', b.voter, 'jury', b.jury, 'country', b.country, 'source', b.source, 'created_at', b.created_at,
        'votes', coalesce((select jsonb_object_agg(v.song, v.points) from public.votes v where v.voter = b.voter), '{}'::jsonb)
      ) order by b.created_at desc), '[]'::jsonb)
      from public.ballots b
    )
  );
end;
$$;

-- Adds a ballot, checked like a cast one, say for votes that came by email. It counts even
-- while voting is closed. Returns the new ballot's id.
create or replace function public.admin_add_ballot(jury text, votes jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  id uuid := gen_random_uuid();
begin
  perform public.require_admin();
  insert into public.ballots (voter, jury, source) values (id, public.checked_jury(jury, votes), 'admin');
  insert into public.votes (voter, song, points)
  select id, v.key, (v.value #>> '{}')::smallint from jsonb_each(votes) v;
  return id;
end;
$$;

-- Deletes a ballot and its points. A voter whose ballot is deleted can vote again.
create or replace function public.admin_delete_ballot(ballot uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  delete from public.ballots b where b.voter = ballot;
  if not found then
    raise exception 'That ballot is gone already.';
  end if;
end;
$$;

-- Opens or closes voting.
create or replace function public.admin_set_open(open boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  update public.contest c set open = admin_set_open.open;
end;
$$;

revoke all on function
  public.checked_jury(text, jsonb), public.cast_ballot(text, jsonb), public.my_ballot(), public.scoreboard(),
  public.is_admin(), public.require_admin(), public.admin_overview(), public.admin_add_ballot(text, jsonb),
  public.admin_delete_ballot(uuid), public.admin_set_open(boolean)
from public, anon, authenticated;
grant execute on function
  public.is_admin(), public.admin_overview(), public.admin_add_ballot(text, jsonb),
  public.admin_delete_ballot(uuid), public.admin_set_open(boolean)
to authenticated;
-- Anonymous users sign in with the authenticated role, like everyone else who signed in.
grant execute on function public.cast_ballot(text, jsonb), public.my_ballot() to authenticated;
grant execute on function public.scoreboard() to anon, authenticated;
