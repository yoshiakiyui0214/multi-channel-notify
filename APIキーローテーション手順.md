# APIキー・シークレット ローテーション手順(開発者向け)

このシステムは以下の外部サービスのキーに依存しています。漏洩やローテーションが
必要になった場合の手順をまとめます。

## 管理しているシークレット一覧

Supabase Edge Functions の Secrets で一元管理しています
(`https://supabase.com/dashboard/project/fpeimmpepmxiewmdssjt/functions/secrets`)。

| シークレット名 | 用途 | 再発行元 |
|---|---|---|
| `SLACK_WEBHOOK_PROPERTY_CONTACT` | Slack `#物件連絡` への通知 | Slack App設定画面 |
| `ANTHROPIC_API_KEY` | AI分類(Claude API) | Anthropic Console |
| `LINE_CHANNEL_ID` | LINE公式アカウント識別 | LINE Developers コンソール |
| `LINE_CHANNEL_SECRET` | LINE Webhookの署名検証 | LINE Developers コンソール(チャネル基本設定) |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINEへのメッセージ送信 | LINE Developers コンソール(Messaging API設定) |
| `LINE_URGENT_CONTACT_GROUP_ID` | 緊急通知先LINEグループのID | (キーではなくID。グループ変更時のみ更新) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | Gmail取得 | Google Cloud Console |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions間の内部呼び出し | Supabase自動発行(通常再発行不要) |

## キーが漏洩した場合の対応手順

### 1. LINE Channel Secret / Access Token が漏洩した場合

1. LINE Developersコンソール(`https://developers.line.biz/console/`)にログイン
2. 対象チャネルの「チャネル基本設定」→ Channel Secretを再発行
3. 「Messaging API設定」→ Channel Access Tokenを再発行(失効させてから新規発行)
4. Supabase Secretsの `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` を新しい値に更新
5. `line-webhook` 関数を再デプロイ(Secrets反映のため)
6. テストメッセージを送信し、署名検証を通過して通知まで届くか確認

### 2. Slack Webhook URLが漏洩した場合

1. Slack Appの設定画面で、該当のIncoming Webhookを削除
2. 新しいWebhook URLを発行
3. Supabase Secretsの `SLACK_WEBHOOK_PROPERTY_CONTACT` を更新
4. `classify-and-notify` 関数を再デプロイ

### 3. Anthropic API Keyが漏洩した場合

1. Anthropic Consoleで該当キーを失効
2. 新しいキーを発行
3. Supabase Secretsの `ANTHROPIC_API_KEY` を更新
4. `classify-and-notify` 関数を再デプロイ

### 4. Google (Gmail) 認証情報が漏洩した場合

1. Google Cloud Consoleで該当のOAuthクライアントを無効化
2. 新しいクライアントID/シークレットを発行し、再度OAuth同意フローを実施してrefresh tokenを取得
3. Supabase Secretsの3つの値をすべて更新
4. `fetch-gmail` 関数を再デプロイ

## 更新後の動作確認チェックリスト

- [ ] Supabase Secretsの値を更新した
- [ ] 該当するEdge Functionを再デプロイした(Secretsは再デプロイ後に反映される場合がある)
- [ ] テストメッセージを送信し、Slack通知が届くことを確認した
- [ ] クレーム系のテストメッセージで、LINE緊急通知も届くことを確認した
- [ ] Supabaseのログ(Logs タブ)にエラーが出ていないことを確認した

## 定期ローテーションの推奨頻度

明確な業界標準はありませんが、目安として以下を推奨します。

- LINE / Slack / Anthropic のキー: 半年〜1年に一度、または担当者交代時
- Google OAuth refresh token: 有効期限切れ時に自動更新が必要になることがあるため、
  `fetch-gmail` の実行ログでの認証エラーに注意する
