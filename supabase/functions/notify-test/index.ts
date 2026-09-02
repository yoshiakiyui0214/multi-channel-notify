import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const WEBHOOK_ENV_KEY = "SLACK_WEBHOOK_PROPERTY_CONTACT";
const MESSAGE = "テスト通知です";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async () => {
  // 通知先マスタ (notification_targets.destination) はキー名のみを保持し、
  // Webhook URL 本体はシークレットから解決する
  const webhookUrl = Deno.env.get(WEBHOOK_ENV_KEY);

  if (!webhookUrl) {
    return json(
      { success: false, error: `Secret ${WEBHOOK_ENV_KEY} is not set` },
      500,
    );
  }

  let res: Response;
  try {
    res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: MESSAGE }),
    });
  } catch (err) {
    return json(
      { success: false, error: `Request to Slack failed: ${err}` },
      502,
    );
  }

  if (!res.ok) {
    // Slack は失敗理由を本文で返す (invalid_token, no_service など)
    const detail = await res.text();
    return json(
      { success: false, error: `Slack responded ${res.status}: ${detail}` },
      502,
    );
  }

  return json({ success: true }, 200);
});
