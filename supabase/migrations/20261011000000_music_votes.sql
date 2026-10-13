-- The jury vote on the music page (public/music.html), as at the Eurovision Song Contest:
-- each jury gives 12, 10, 8, 7 and down to 1 points, each score to one song only.
--
-- The page is static and talks to Supabase with the public anon key, so nothing here trusts
-- the browser:
--   * Every voter is a Supabase user, an anonymous one by default (Authentication → Sign In /
--     Providers → Allow anonymous sign-ins). A user has one ballot; casting again replaces it.
--   * The tables have row level security on and no policies, and anon and authenticated
--     have no rights on them: the page cannot read or write a row directly.
--   * All access goes through three functions: cast_ballot checks every vote before it is
--     stored, my_ballot returns the caller's own ballot only, and scoreboard returns the
--     totals only, never who gave what, nor the jury names people typed in.
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
  voter uuid primary key references auth.users (id) on delete cascade,
  jury text not null default '' check (char_length(jury) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- ISO 3166 code from CF-IPCountry, such as AT; null when unknown.
  country text check (country ~ '^[A-Z]{2}$')
);
-- For projects that ran this file before the country was kept.
alter table public.ballots add column if not exists country text check (country ~ '^[A-Z]{2}$');

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
revoke all on table public.songs, public.contest, public.ballots, public.votes from public, anon, authenticated;

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

-- Casts or replaces the caller's ballot. votes is an object of song id to points, such as
-- {"klingon": 12, "greek": 10}. Errors raised here (SQLSTATE P0001) are meant for the voter.
create or replace function public.cast_ballot(jury text, votes jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  clean_jury text;
  last_cast timestamptz;
  -- PostgREST hands the request headers over as JSON, with lower-case names.
  country text := upper(nullif(current_setting('request.headers', true), '')::json ->> 'cf-ipcountry');
begin
  if me is null then
    raise exception 'Sign in to vote.' using errcode = '28000';
  end if;
  if not (select c.open from public.contest c) then
    raise exception 'Voting is closed.';
  end if;
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

  -- One ballot per voter, which a voter can change, but not in a tight loop.
  select b.updated_at into last_cast from public.ballots b where b.voter = me for update;
  if last_cast > now() - interval '5 seconds' then
    raise exception 'Easy, jury: wait a few seconds before you vote again.';
  end if;

  -- XX is Cloudflare's "unknown" and T1 is Tor: neither is a country.
  if country !~ '^[A-Z]{2}$' or country in ('XX', 'T1') then
    country := null;
  end if;

  insert into public.ballots as b (voter, jury, country) values (me, clean_jury, country)
  on conflict (voter) do update set jury = excluded.jury, country = excluded.country, updated_at = now();
  delete from public.votes v where v.voter = me;
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

revoke all on function public.cast_ballot(text, jsonb), public.my_ballot(), public.scoreboard() from public, anon, authenticated;
-- Anonymous users sign in with the authenticated role, like everyone else who signed in.
grant execute on function public.cast_ballot(text, jsonb), public.my_ballot() to authenticated;
grant execute on function public.scoreboard() to anon, authenticated;
