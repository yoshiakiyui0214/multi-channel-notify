# multi-channel-notify

不動産管理会社向けマルチチャネル通知システム(メール/LINE→AI分類→Slack通知、緊急時LINE即時通知)

## 目次

- [プロジェクト概要](#プロジェクト概要)
- [アーキテクチャ](#アーキテクチャ)
- [環境変数・シークレット一覧](#環境変数シークレット一覧)
- [動作確認済みの検証結果](#動作確認済みの検証結果)
- [運用ドキュメント](#運用ドキュメント)
- [Phase 2 提案](#phase-2-提案)

## プロジェクト概要

メール・LINEに届く不動産管理会社宛の問い合わせを自動で受信し、Claudeが
「賃貸/売買/内見/クレーム」の4カテゴリに分類、Slackへ振り分け通知する。
クレーム(緊急案件)は追加でLINEグループへ即時通知する。

| 項目 | 内容 |
|---|---|
| 対象 | 不動産管理会社の問い合わせ対応(メール・LINE) |
| 分類 | 賃貸 / 売買 / 内見 / クレーム(Claude APIによる自動分類) |
| 緊急通知SLA | クレーム検出から5分以内にLINEグループへ通知 |
| バックエンド | Supabase(Postgres, Edge Functions, pg_cron, pg_net) |
| AI | Anthropic Claude API |
| 通知先 | Slack(Webhook) / LINE(Messaging API) |

## アーキテクチャ

```
Gmail ──(5分おきpg_cron)──> fetch-gmail ─┐
                                          ├──> classify-and-notify ──> Slack (#物件連絡)
LINE公式アカウント ──(Webhook)──> line-webhook ─┘         │
                                                            └──(緊急のみ)──> LINEグループ
```

- **fetch-gmail**: Supabaseの`pg_cron`が5分おきに起動し、Gmailの未読メールを取得
- **line-webhook**: お客様からのLINE個別メッセージを受信(署名検証あり)。緊急連絡用グループのメッセージは処理対象外
- **classify-and-notify**: 受信した問い合わせをClaude APIで分類し、`notification_targets`テーブルの設定に従ってSlack/LINEへ通知。`external_id`にUNIQUE制約があり、Webhookの重複配信があっても二重通知しない

## 環境変数・シークレット一覧

Supabase Edge Functions の Secrets で管理。詳細と再発行手順は
[`docs/APIキーローテーション手順.md`](./docs/APIキーローテーション手順.md) を参照。

| 名前 | 用途 |
|---|---|
| `SLACK_WEBHOOK_PROPERTY_CONTACT` | Slack `#物件連絡` への通知 |
| `ANTHROPIC_API_KEY` | AI分類 |
| `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` | LINE公式アカウント連携 |
| `LINE_URGENT_CONTACT_GROUP_ID` | 緊急通知先LINEグループのID |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | Gmail取得 |

## 動作確認済みの検証結果

クライアント提供のテスト問い合わせ22件(賃貸/売買/内見/クレームの比率をヒアリング
結果に沿って作成したダミーデータ)で検証済み。

- 分類精度: 22件中21件が期待カテゴリと一致(残り1件は無関係な内容を4カテゴリに
  強制分類する仕様上の制約であり、誤通知や事故には至らない)
- 緊急通知(クレーム→LINE Push): 2件中2件成功、5分以内SLAを達成(実測は送信から
  1秒未満)
- 緊急キーワードの誤検知: 「これは緊急ではありません」という文言を含む通常の
  問い合わせで、誤って緊急判定しないことを確認済み
- Webhookの署名検証: 不正な署名のリクエストを401で拒否することを確認済み

## 運用ドキュメント

- [運用マニュアル(クライアント向け)](./docs/運用マニュアル.md)
- [APIキーローテーション手順(開発者向け)](./docs/APIキーローテーション手順.md)
- [監視用SQLクエリ集](./docs/monitoring.md)

## Phase 2 提案

電話問い合わせの自動化(Twilio + 音声テキスト化)は今回のMVP範囲外。
月50件の電話問い合わせを既存のAI分類フローに合流させる継続案件として提案中。
