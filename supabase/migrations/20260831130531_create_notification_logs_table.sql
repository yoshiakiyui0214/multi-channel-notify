create table public.notification_logs (
  id                   uuid primary key default gen_random_uuid(),
  message_id           uuid not null references public.messages (id) on delete cascade,
  target_id            uuid references public.notification_targets (id) on delete set null,
  channel              public.notify_channel not null,
  destination          text not null,
  status               public.notify_status not null default 'pending',
  attempt              smallint not null default 1 check (attempt >= 1),
  provider_message_id  text,
  error_message        text,
  http_status          smallint,
  sent_at              timestamptz,
  created_at           timestamptz not null default now()
);

comment on table  public.notification_logs is '通知送信の履歴。リトライは行を更新せず追記し、何回目で成功したかを残す';
comment on column public.notification_logs.target_id           is '使用した notification_targets の行。宛先マスタが削除されても履歴は残す (ON DELETE SET NULL)';
comment on column public.notification_logs.destination         is '送信時点の宛先を実値で保存 (マスタ変更後も当時の送信先を追跡できる)';
comment on column public.notification_logs.attempt             is 'リトライ回数。1 が初回';
comment on column public.notification_logs.provider_message_id is 'Slack の ts / LINE の request id';
comment on column public.notification_logs.http_status         is '失敗の切り分け用 (429 = レート制限, 4xx = 設定ミス等)';

create index notification_logs_message_id_idx
  on public.notification_logs (message_id);

-- 失敗分の再送・監視
create index notification_logs_failed_idx
  on public.notification_logs (status, created_at desc)
  where status = 'failed';

alter table public.notification_logs enable row level security;
