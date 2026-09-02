-- data/fan-faces.sql
--
-- Paste into Supabase → SQL Editor → Run.
--
-- Why the crown on a contender's frame is still a crown and not a face.
--
-- The badge shows the picture of whoever has put the most behind that
-- contender. It can only show a picture that exists: users.photo_path. Where
-- that is empty the badge falls back to a crown, which is what "I can't see the
-- face" looks like from the outside.
--
-- Two parts. The first reports. The second fixes the common cause and is the
-- only part that writes anything.

-- ── 1. Who leads a contender, and what the badge has to work with ───────────
--
-- photo: 'yes' means a face will show. social: 'yes' means clicking it goes to
-- their account rather than to the contender's fan list.
select coalesce(u.display_name, '(no name)')                as fan,
       case when u.is_anonymous then 'anonymous — no face by choice'
            when coalesce(nullif(btrim(u.photo_path), ''), '') = '' then 'NO PHOTO — badge shows a crown'
            else 'yes' end                                  as photo,
       case when u.is_anonymous then 'anonymous'
            when coalesce(nullif(btrim(u.social_handle), ''), '') = '' then 'no handle — links to the fan list'
            else '@' || u.social_handle || ' on ' || coalesce(u.social_platform,'x') end as social,
       count(distinct f.person_id)                          as contenders_they_lead,
       max(f.total_cents) / 100                             as biggest_backing_dollars
  from fan_totals f
  join users u on u.id = f.user_id
 where f.total_cents > 0
   and f.total_cents = (select max(f2.total_cents) from fan_totals f2 where f2.person_id = f.person_id)
 group by u.id, u.display_name, u.is_anonymous, u.photo_path, u.social_handle, u.social_platform
 order by max(f.total_cents) desc;

-- ── 2. Take the picture Google already gave us ──────────────────────────────
--
-- Anyone who signed in with Google handed over an avatar at that moment, and it
-- sits in auth.users.raw_user_meta_data untouched. The page copies it into
-- users.photo_path, but only for whoever is currently looking — so a fan who has
-- not opened the site since that code shipped still has an empty photo_path and
-- still shows as a crown to everybody else.
--
-- This copies it for all of them at once. It only fills empties: a photo
-- somebody uploaded themselves is never overwritten.
update users u
   set photo_path = coalesce(au.raw_user_meta_data->>'avatar_url',
                             au.raw_user_meta_data->>'picture')
  from auth.users au
 where au.id = u.id
   and coalesce(nullif(btrim(u.photo_path), ''), '') = ''
   and coalesce(au.raw_user_meta_data->>'avatar_url',
                au.raw_user_meta_data->>'picture') is not null;

-- ── 3. What that changed ────────────────────────────────────────────────────
select count(*)                                                           as fans_with_money,
       count(*) filter (where coalesce(nullif(btrim(photo_path),''),'') <> '') as have_a_photo,
       count(*) filter (where coalesce(nullif(btrim(social_handle),''),'') <> '') as have_a_handle
  from users
 where total_spent_cents > 0;

-- Anyone still without a photo either signed in by email, or signed in with
-- Google before this was recorded. They add one from the avatar in the top
-- right of the site — which needs the avatars bucket, created by
-- supabase-profile-gate.sql. Without that bucket an upload fails and the form
-- now says so instead of closing as though it worked.
