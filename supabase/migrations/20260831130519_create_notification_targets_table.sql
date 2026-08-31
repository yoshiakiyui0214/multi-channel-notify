create table public.notification_targets (
  id                 uuid primary key default gen_random_uuid(),
  category           text,
  channel_type       public.notify_channel not null,
  destination        text not null,
  destination_label  text,
  urgent_only        boolean not null default false,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table  public.notification_targets is 'カテゴリ別の通知先マスタ (category -> channel_type -> 宛先)';
comment on column public.notification_targets.category          is '対象カテゴリ。NULL は全カテゴリ対象 (catch-all)';
comment on column public.notification_targets.destination       is 'Slack channel ID または LINE userId / groupId';
comment on column public.notification_targets.destination_label is '人が読める宛先名 (例: #緊急対応, 山田管理人)';
comment on column public.notification_targets.urgent_only       is 'true の場合、messages.is_urgent = true のときのみ送信 (緊急時 LINE 即時通知用)';
comment on column public.notification_targets.is_active         is 'false で論理削除。履歴を壊さず宛先を無効化できる';

-- 同一の (カテゴリ, チャネル, 宛先) の重複登録を防止
-- NULLS NOT DISTINCT により catch-all 行 (category IS NULL) も重複排除の対象になる
create unique index notification_targets_unique_route
  on public.notification_targets (category, channel_type, destination)
  nulls not distinct;

-- 配信時のルート解決 (有効な宛先のみ)
create index notification_targets_lookup_idx
  on public.notification_targets (category, channel_type)
  where is_active;

create trigger notification_targets_set_updated_at
  before update on public.notification_targets
  for each row execute function public.set_updated_at();

alter table public.notification_targets enable row level security;
