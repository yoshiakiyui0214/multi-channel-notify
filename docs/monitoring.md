# 監視用SQLクエリ集

Supabase の SQL Editor でそのまま実行できます。専用の監視ツール(Datadog等)は
使わず、Supabase 標準機能だけで運用コストゼロの監視を実現しています。

## 1. 手動確認用:直近24時間のステータス別件数

日常的な健康チェックはこれ1本で十分です。

```sql
select status, count(*)
from messages
where received_at > now() - interval '24 hours'
group by status;
```

`failed` が並んでいたら要注意。詳細は次のクエリで確認します。

## 2. 失敗した問い合わせの詳細確認

```sql
select id, source_channel, subject, body, error_message, received_at
from messages
where status = 'failed'
  and received_at > now() - interval '24 hours'
order by received_at desc;
```

## 3. 通知チャネル別の成功率

```sql
select
  channel,
  count(*) filter (where status = 'success') as success_count,
  count(*) filter (where status = 'failed') as failed_count,
  round(
    count(*) filter (where status = 'success')::numeric / count(*) * 100, 1
  ) as success_rate_pct
from notification_logs
where sent_at > now() - interval '24 hours'
group by channel;
```

## 4. 自動アラート(1時間ごと、失敗5件以上でSlack通知)

`pg_cron` + `pg_net` を使い、専用ワーカーを書かずに無料の障害検知を実現しています。
以下を SQL Editor で一度だけ実行すれば、以後は自動で動き続けます。

```sql
select cron.schedule(
  'monitor-failed-messages-hourly',
  '0 * * * *',  -- 1時間おき
  $$
  do $body$
  declare
    failed_count int;
  begin
    select count(*) into failed_count
    from messages
    where status = 'failed'
      and received_at > now() - interval '1 hour';

    if failed_count >= 5 then
      perform net.http_post(
        url := 'YOUR_SLACK_WEBHOOK_URL',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object(
          'text', format('⚠️ 直近1時間でメッセージ処理が%s件失敗しています。Supabaseのmessagesテーブルを確認してください。', failed_count)
        )
      );
    end if;
  end;
  $body$;
  $$
);
```

`YOUR_SLACK_WEBHOOK_URL` は、既存の `#物件連絡` チャネル用の Webhook URL
(Supabase Secrets の `SLACK_WEBHOOK_PROPERTY_CONTACT` と同じ値)に置き換えてください。

### 登録済みcronジョブの確認方法

```sql
select jobid, jobname, schedule, active
from cron.job
order by jobid;
```

### cronジョブの停止方法(不要になった場合)

```sql
select cron.unschedule('monitor-failed-messages-hourly');
```
