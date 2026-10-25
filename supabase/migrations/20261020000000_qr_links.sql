-- QR codes with counted scans, made on the admin page (public/music-admin.html). Each code
-- links to a page of the site with ?qr=<slug>, such as music.html?qr=happylab-poster; the
-- page tells the database it was opened that way (public/js/qr-track.js), then drops the
-- parameter from the address bar, so a reload or a shared link does not count again.
--
-- The same rules as the jury vote (20261011000000_music_votes.sql, run that one first):
--   * The tables have row level security on and no policies, and anon and authenticated
--     have no rights on them.
--   * Anyone may call track_qr_scan, as scanning needs no account. It only counts codes an
--     admin made, ignores everything else without a word, and keeps the time and the
--     two-letter country from CF-IPCountry: no IP address, no user, nothing from the browser
--     but the slug. Anyone can still call it by hand and inflate a count, so the counts are a
--     good guess, not proof; at most SCAN_LIMIT_PER_MINUTE scans a minute count per code,
--     which keeps the table small whatever happens.
--   * Making, listing and deleting codes go through admin_* functions that check
--     public.is_admin() first.
--
-- Run it once in the SQL editor of your Supabase project, or with `supabase db push`.
-- It can be run again: the functions are replaced.

create table if not exists public.qr_links (
  -- The ?qr= value in the link: short, so the code stays small and easy to scan.
  slug text primary key check (slug ~ '^[a-z0-9-]{1,40}$'),
  -- What the code is for, such as "Poster at the Happylab": for the admins only.
  label text not null default '' check (char_length(label) <= 80),
  -- The page the code opens, relative to the site, such as music.html. An empty target is
  -- the start page.
  target text not null default '' check (target ~ '^([a-z0-9-]{1,40}\.html)?$'),
  created_at timestamptz not null default now()
);

create table if not exists public.qr_scans (
  id bigint generated always as identity primary key,
  slug text not null references public.qr_links (slug) on delete cascade,
  scanned_at timestamptz not null default now(),
  -- ISO 3166 code from CF-IPCountry, such as AT; null when unknown.
  country text check (country ~ '^[A-Z]{2}$')
);
create index if not exists qr_scans_slug_time on public.qr_scans (slug, scanned_at);

alter table public.qr_links enable row level security;
alter table public.qr_scans enable row level security;
revoke all on table public.qr_links, public.qr_scans from public, anon, authenticated;

-- Counts one scan of a code. Unknown codes and scans over the limit are dropped without an
-- error, so the page learns nothing from calling it.
create or replace function public.track_qr_scan(slug text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- How many scans a minute count for one code; more are dropped.
  scan_limit_per_minute constant int := 60;
  -- PostgREST hands the request headers over as JSON, with lower-case names.
  country text := upper(nullif(current_setting('request.headers', true), '')::json ->> 'cf-ipcountry');
begin
  if track_qr_scan.slug is null or track_qr_scan.slug !~ '^[a-z0-9-]{1,40}$' then
    return;
  end if;
  -- Locks the code until this scan is stored, so scans of one code take turns: two at the same
  -- moment cannot both pass the limit below. The lock leaves foreign key checks alone.
  perform 1 from public.qr_links l where l.slug = track_qr_scan.slug for no key update;
  if not found then
    return;
  end if;
  if (select count(*) from public.qr_scans s
      where s.slug = track_qr_scan.slug and s.scanned_at > now() - interval '1 minute') >= scan_limit_per_minute then
    return;
  end if;
  -- XX is Cloudflare's "unknown" and T1 is Tor: neither is a country.
  if country !~ '^[A-Z]{2}$' or country in ('XX', 'T1') then
    country := null;
  end if;
  insert into public.qr_scans (slug, country) values (track_qr_scan.slug, country);
end;
$$;

-- For the admin page: every code, newest first, with its scans in all, in the last 7 days,
-- the last one, the countries (most scans first) and the scans of each of the last 30 days
-- (UTC), oldest first, days without scans included. The scans are grouped once per view
-- (by code, by code and country, by code and day), not counted again for every code and day.
create or replace function public.admin_qr_links()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  today constant timestamptz := date_trunc('day', now(), 'UTC');
begin
  perform public.require_admin();
  return (
    with
      totals as (
        select s.slug, count(*) as scans,
          count(*) filter (where s.scanned_at > now() - interval '7 days') as week,
          max(s.scanned_at) as last
        from public.qr_scans s
        group by s.slug
      ),
      countries as (
        select c.slug, jsonb_agg(jsonb_build_object('country', c.country, 'scans', c.scans) order by c.scans desc, c.country) as list
        from (
          select s.slug, s.country, count(*) as scans from public.qr_scans s group by s.slug, s.country
        ) c
        group by c.slug
      ),
      by_day as (
        select s.slug, date_trunc('day', s.scanned_at, 'UTC') as day, count(*) as scans
        from public.qr_scans s
        where s.scanned_at >= today - interval '29 days'
        group by s.slug, date_trunc('day', s.scanned_at, 'UTC')
      ),
      days as (
        select l.slug, jsonb_agg(jsonb_build_object('day', d.day, 'scans', coalesce(b.scans, 0)) order by d.day) as list
        from public.qr_links l
        cross join generate_series(today - interval '29 days', today, interval '1 day') as d(day)
        left join by_day b on b.slug = l.slug and b.day = d.day
        group by l.slug
      )
    select coalesce(jsonb_agg(jsonb_build_object(
      'slug', l.slug, 'label', l.label, 'target', l.target, 'created_at', l.created_at,
      'scans', coalesce(t.scans, 0),
      'week', coalesce(t.week, 0),
      'last', t.last,
      'countries', coalesce(c.list, '[]'::jsonb),
      'days', d.list
    ) order by l.created_at desc), '[]'::jsonb)
    from public.qr_links l
    left join totals t on t.slug = l.slug
    left join countries c on c.slug = l.slug
    left join days d on d.slug = l.slug
  );
end;
$$;

-- Makes a code. The slug is checked here too, and must be new: a printed code keeps its link.
create or replace function public.admin_add_qr_link(slug text, label text, target text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_label text := btrim(regexp_replace(coalesce(label, ''), '[[:cntrl:][:space:]]+', ' ', 'g'));
begin
  perform public.require_admin();
  if admin_add_qr_link.slug is null or admin_add_qr_link.slug !~ '^[a-z0-9-]{1,40}$' then
    raise exception 'The short name takes lower-case letters, digits and dashes, 40 at most.';
  end if;
  if char_length(clean_label) > 80 then
    raise exception 'The description is too long: 80 characters at most.';
  end if;
  if coalesce(admin_add_qr_link.target, '') !~ '^([a-z0-9-]{1,40}\.html)?$' then
    raise exception 'That page is not on this site.';
  end if;
  insert into public.qr_links (slug, label, target)
  values (admin_add_qr_link.slug, clean_label, coalesce(admin_add_qr_link.target, ''))
  on conflict on constraint qr_links_pkey do nothing;
  if not found then
    raise exception 'There is a code with that short name already. Pick another one.';
  end if;
end;
$$;

-- Deletes a code and its scans. A printed copy then opens the page without being counted.
create or replace function public.admin_delete_qr_link(slug text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  delete from public.qr_links l where l.slug = admin_delete_qr_link.slug;
  if not found then
    raise exception 'That code is gone already.';
  end if;
end;
$$;

revoke all on function
  public.track_qr_scan(text), public.admin_qr_links(), public.admin_add_qr_link(text, text, text),
  public.admin_delete_qr_link(text)
from public, anon, authenticated;
grant execute on function public.track_qr_scan(text) to anon, authenticated;
grant execute on function
  public.admin_qr_links(), public.admin_add_qr_link(text, text, text), public.admin_delete_qr_link(text)
to authenticated;
