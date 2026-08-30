-- data/add-video-column.sql
-- Adds the clip reference used by js/video-hover.js.
--
-- video_path holds either a full URL or a path inside the same public storage
-- bucket the photos come from, exactly like photo_path. A person with no clip
-- keeps rendering their still, so this is safe to run before any video exists.

alter table people add column if not exists video_path text;

-- Example: point a contender at a clip already uploaded to storage.
-- update people set video_path = 'clips/sachin-tendulkar.mp4'
--  where slug = 'sachin-tendulkar';

-- Which contenders currently have a clip:
-- select count(*) filter (where video_path is not null) as with_clip,
--        count(*) as total
--   from people;
