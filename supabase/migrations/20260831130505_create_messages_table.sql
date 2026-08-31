create table public.messages (
  id                  uuid primary key default gen_random_uuid(),
  source_channel      public.message_channel not null,
  external_id         text not null,
  sender              text not null,
  sender_name         text,
  subject             text,
  body                text not null,
  category            text,
  is_urgent           boolean not null default false,
  confidence          numeric(4,3) check (confidence >= 0 and confidence <= 1),
  classification_raw  jsonb,
  status              public.message_status not null default 'received',
  error_message       text,
  received_at         timestamptz not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table  public.messages is 'メール/LINE から受信したメッセージのログと AI 分類結果';
comment on column public.messages.external_id        is '元メッセージの識別子 (メール Message-ID / LINE webhook event id)。重複受信の排除に使用';
comment on column public.messages.category           is 'AI 分類結果。運用中に項目が増える想定のため enum ではなく text';
comment on column public.messages.confidence         is '分類の確信度 (0.000-1.000)。低い場合は人手確認へ回す判断材料';
comment on column public.messages.classification_raw is 'AI の生レスポンス。プロンプト改善・誤分類の監査用';
comment on column public.messages.received_at        is 'メッセージが実際に届いた時刻 (DB 挿入時刻である created_at とは別管理)';

-- 同一チャネル内での重複受信を防止
create unique index messages_source_channel_external_id_key
  on public.messages (source_channel, external_id);

-- 未処理キューの取得
create index messages_pending_status_idx
  on public.messages (status)
  where status <> 'notified';

-- 一覧・ダッシュボード
create index messages_received_at_idx
  on public.messages (received_at desc);

-- 緊急案件の抽出
create index messages_urgent_idx
  on public.messages (is_urgent, received_at desc)
  where is_urgent;

create trigger messages_set_updated_at
  before update on public.messages
  for each row execute function public.set_updated_at();

-- RLS 有効化・ポリシーなし = service_role のみアクセス可 (anon / authenticated は全拒否)
alter table public.messages enable row level security;
