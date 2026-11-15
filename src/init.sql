create table if not exists _tgpg_meta(k text primary key, v bigint not null);
insert into _tgpg_meta values ('last', 0) on conflict do nothing;
create table if not exists _tgpg_seen(oid text primary key, msg bigint not null);   -- dedupe op (retry kirim)
create table if not exists _tgpg_ctl(k text primary key, v text not null);            -- owner, epoch
create table if not exists _tgpg_member(sid text primary key, pub text not null default '', name text not null default '', status text not null);
create or replace function tg_now() returns timestamptz language sql volatile as
$$ select coalesce(nullif(current_setting('tgpg.ts', true), '')::timestamptz, now()) $$;
create or replace function tg_uuid() returns uuid language plpgsql volatile as
$$ declare n int; s text;
begin
  s := current_setting('tgpg.seed', true);
  if s is null or s = '' then return gen_random_uuid(); end if;
  n := coalesce(nullif(current_setting('tgpg.n', true), ''), '0')::int + 1;
  perform set_config('tgpg.n', n::text, true);
  return md5(s || ':' || n::text)::uuid;
end $$;
create or replace function tg_random() returns double precision language plpgsql volatile as
$$ declare n int; s text;
begin
  s := current_setting('tgpg.seed', true);
  if s is null or s = '' then return random(); end if;
  n := coalesce(nullif(current_setting('tgpg.n', true), ''), '0')::int + 1;
  perform set_config('tgpg.n', n::text, true);
  return (('x' || substr(md5(s || ':r:' || n::text), 1, 8))::bit(32)::bigint)::double precision / 4294967296.0;
end $$;
