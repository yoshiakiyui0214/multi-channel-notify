-- 受信チャネル / 通知チャネル / 各種ステータスの enum
create type public.message_channel as enum ('email', 'line');
create type public.message_status  as enum ('received', 'classifying', 'classified', 'notified', 'failed');
create type public.notify_channel  as enum ('slack', 'line');
create type public.notify_status   as enum ('pending', 'success', 'failed');

-- updated_at を自動更新する共通トリガ関数
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
