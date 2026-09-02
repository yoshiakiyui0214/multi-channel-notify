import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_MODEL = "claude-sonnet-5";
const CATEGORIES = ["賃貸", "売買", "クレーム", "内見"] as const;
type Category = (typeof CATEGORIES)[number];

const VALID_SOURCE_CHANNELS = ["email", "line"] as const;
type SourceChannel = (typeof VALID_SOURCE_CHANNELS)[number];

interface RequestPayload {
  source_channel: SourceChannel;
  external_id: string;
  sender: string;
  sender_name?: string | null;
  subject?: string | null;
  body: string;
  received_at?: string;
}

interface Classification {
  category: Category;
  is_urgent: boolean;
  confidence: number;
  raw: unknown;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isValidPayload(value: unknown): value is RequestPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.source_channel === "string" &&
    (VALID_SOURCE_CHANNELS as readonly string[]).includes(v.source_channel) &&
    typeof v.external_id === "string" &&
    v.external_id.length > 0 &&
    typeof v.sender === "string" &&
    v.sender.length > 0 &&
    typeof v.body === "string" &&
    v.body.length > 0
  );
}

async function classifyMessage(
  subject: string | null | undefined,
  body: string,
): Promise<Classification> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("Secret ANTHROPIC_API_KEY is not set");
  }

  const systemPrompt =
    "あなたは不動産管理会社に届いたメッセージを分類するアシスタントです。" +
    "件名と本文の内容から、次の4カテゴリのいずれか1つに分類してください。\n" +
    "- 賃貸: 入居希望、賃貸条件の問い合わせ、契約更新・解約など\n" +
    "- 売買: 物件の売却・購入の相談\n" +
    "- クレーム: 苦情、設備故障、騒音などのトラブル\n" +
    "- 内見: 内見の予約・日程調整\n" +
    "加えて、クレームまたは水漏れ・鍵の故障・騒音など生活に支障が出る設備トラブルに関する内容であれば " +
    "is_urgent を true にしてください。それ以外は false としてください。\n" +
    "分類結果は必ず classify_message ツールで返してください。";

  const userContent = `件名: ${subject ?? "(なし)"}\n本文:\n${body}`;

  const tool = {
    name: "classify_message",
    description: "受信メッセージのカテゴリと緊急度を返す",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: CATEGORIES },
        is_urgent: { type: "boolean" },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "分類の確信度 (0-1)",
        },
        reasoning: { type: "string", description: "分類理由の簡潔な説明" },
      },
      required: ["category", "is_urgent", "confidence", "reasoning"],
    },
  };

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
        tools: [tool],
        tool_choice: { type: "tool", name: "classify_message" },
      }),
    });
  } catch (err) {
    throw new Error(`Request to Claude API failed: ${err}`);
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude API responded ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const toolUse = Array.isArray(data.content)
    ? data.content.find(
        (block: { type?: string; name?: string }) =>
          block.type === "tool_use" && block.name === "classify_message",
      )
    : undefined;

  if (!toolUse) {
    throw new Error("Claude API did not return a classify_message tool call");
  }

  const input = toolUse.input as {
    category: string;
    is_urgent: boolean;
    confidence: number;
  };

  if (!(CATEGORIES as readonly string[]).includes(input.category)) {
    throw new Error(`Unexpected category from Claude: ${input.category}`);
  }

  return {
    category: input.category as Category,
    is_urgent: Boolean(input.is_urgent),
    confidence: input.confidence,
    raw: data,
  };
}

Deno.serve(async (req: Request) => {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400);
  }

  if (!isValidPayload(payload)) {
    return json(
      {
        success: false,
        error:
          "Missing or invalid fields. Required: source_channel (email|line), external_id, sender, body",
      },
      400,
    );
  }

  // 文字化け調査用: 受信直後の body をそのままログに出す
  console.log("Received payload.body:", JSON.stringify(payload.body));

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const receivedAt = payload.received_at ?? new Date().toISOString();

  const { data: inserted, error: insertError } = await supabase
    .from("messages")
    .insert({
      source_channel: payload.source_channel,
      external_id: payload.external_id,
      sender: payload.sender,
      sender_name: payload.sender_name ?? null,
      subject: payload.subject ?? null,
      body: payload.body,
      received_at: receivedAt,
      status: "received",
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      const { data: existing } = await supabase
        .from("messages")
        .select("id, category, is_urgent, status")
        .eq("source_channel", payload.source_channel)
        .eq("external_id", payload.external_id)
        .single();

      return json(
        {
          success: true,
          duplicate: true,
          message_id: existing?.id ?? null,
          category: existing?.category ?? null,
          is_urgent: existing?.is_urgent ?? null,
        },
        200,
      );
    }

    return json(
      { success: false, error: `Failed to save message: ${insertError.message}` },
      500,
    );
  }

  const messageId = inserted.id as string;

  let classification: Classification;
  try {
    classification = await classifyMessage(payload.subject, payload.body);
  } catch (err) {
    await supabase
      .from("messages")
      .update({ status: "failed", error_message: `${err}` })
      .eq("id", messageId);

    return json(
      { success: false, message_id: messageId, error: `Classification failed: ${err}` },
      502,
    );
  }

  const { error: classifyUpdateError } = await supabase
    .from("messages")
    .update({
      category: classification.category,
      is_urgent: classification.is_urgent,
      confidence: classification.confidence,
      classification_raw: classification.raw,
      status: "classified",
    })
    .eq("id", messageId);

  if (classifyUpdateError) {
    return json(
      {
        success: false,
        message_id: messageId,
        error: `Failed to save classification: ${classifyUpdateError.message}`,
      },
      500,
    );
  }

  const { data: candidateTargets, error: targetsError } = await supabase
    .from("notification_targets")
    .select("*")
    .eq("is_active", true)
    .in("channel_type", ["slack", "line"])
    .or(`category.is.null,category.eq.${classification.category}`);

  if (targetsError) {
    await supabase
      .from("messages")
      .update({
        status: "failed",
        error_message: `Failed to resolve notification targets: ${targetsError.message}`,
      })
      .eq("id", messageId);

    return json(
      {
        success: false,
        message_id: messageId,
        error: `Failed to resolve notification targets: ${targetsError.message}`,
      },
      500,
    );
  }

  const targets = (candidateTargets ?? []).filter(
    (t) => !t.urgent_only || classification.is_urgent,
  );

  if (targets.length === 0) {
    await supabase
      .from("messages")
      .update({ status: "failed", error_message: "No active notification target found" })
      .eq("id", messageId);

    return json(
      {
        success: false,
        message_id: messageId,
        category: classification.category,
        is_urgent: classification.is_urgent,
        error: "No active notification target found",
      },
      500,
    );
  }

  const text = `【${classification.category}】${payload.body}`;
  const lineChannelAccessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  const notified: Array<{
    target_id: string;
    channel: "slack" | "line";
    destination_label: string | null;
    status: "success" | "failed";
    error?: string;
  }> = [];

  for (const target of targets) {
    const channelLabel = target.channel_type === "line" ? "LINE" : "Slack";

    const { data: logRow, error: logInsertError } = await supabase
      .from("notification_logs")
      .insert({
        message_id: messageId,
        target_id: target.id,
        channel: target.channel_type,
        destination: target.destination,
        status: "pending",
        attempt: 1,
      })
      .select()
      .single();

    if (logInsertError || !logRow) {
      notified.push({
        target_id: target.id,
        channel: target.channel_type,
        destination_label: target.destination_label,
        status: "failed",
        error: `Failed to record notification log: ${logInsertError?.message}`,
      });
      continue;
    }

    // notification_targets.destination はキー名のみを保持し、実際の送信先(Slack Webhook URL /
    // LINE userId)はシークレットから解決する
    const resolvedDestination = Deno.env.get(target.destination);
    if (!resolvedDestination) {
      await supabase
        .from("notification_logs")
        .update({
          status: "failed",
          error_message: `Secret ${target.destination} is not set`,
        })
        .eq("id", logRow.id);

      notified.push({
        target_id: target.id,
        channel: target.channel_type,
        destination_label: target.destination_label,
        status: "failed",
        error: `Secret ${target.destination} is not set`,
      });
      continue;
    }

    if (target.channel_type === "line" && !lineChannelAccessToken) {
      await supabase
        .from("notification_logs")
        .update({
          status: "failed",
          error_message: "Secret LINE_CHANNEL_ACCESS_TOKEN is not set",
        })
        .eq("id", logRow.id);

      notified.push({
        target_id: target.id,
        channel: target.channel_type,
        destination_label: target.destination_label,
        status: "failed",
        error: "Secret LINE_CHANNEL_ACCESS_TOKEN is not set",
      });
      continue;
    }

    try {
      let sendRes: Response;
      if (target.channel_type === "line") {
        const lineRequestBody = JSON.stringify({
          to: resolvedDestination,
          messages: [{ type: "text", text }],
        });
        // 文字化け調査用: 送信直前のJSONボディをそのままログに出す
        console.log(`LINE push request body (target ${target.id}):`, lineRequestBody);

        sendRes = await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": `Bearer ${lineChannelAccessToken}`,
          },
          // fetch の暗黙の文字列→バイト変換に依存せず、明示的に UTF-8 バイト列を渡す
          body: new TextEncoder().encode(lineRequestBody),
        });
      } else {
        sendRes = await fetch(resolvedDestination, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
      }

      if (!sendRes.ok) {
        const detail = await sendRes.text();
        await supabase
          .from("notification_logs")
          .update({
            status: "failed",
            http_status: sendRes.status,
            error_message: `${channelLabel} responded ${sendRes.status}: ${detail}`,
            sent_at: new Date().toISOString(),
          })
          .eq("id", logRow.id);

        notified.push({
          target_id: target.id,
          channel: target.channel_type,
          destination_label: target.destination_label,
          status: "failed",
          error: `${channelLabel} responded ${sendRes.status}: ${detail}`,
        });
      } else {
        await supabase
          .from("notification_logs")
          .update({
            status: "success",
            http_status: sendRes.status,
            sent_at: new Date().toISOString(),
          })
          .eq("id", logRow.id);

        notified.push({
          target_id: target.id,
          channel: target.channel_type,
          destination_label: target.destination_label,
          status: "success",
        });
      }
    } catch (err) {
      await supabase
        .from("notification_logs")
        .update({
          status: "failed",
          error_message: `Request to ${channelLabel} failed: ${err}`,
        })
        .eq("id", logRow.id);

      notified.push({
        target_id: target.id,
        channel: target.channel_type,
        destination_label: target.destination_label,
        status: "failed",
        error: `Request to ${channelLabel} failed: ${err}`,
      });
    }
  }

  const anySuccess = notified.some((n) => n.status === "success");

  await supabase
    .from("messages")
    .update({
      status: anySuccess ? "notified" : "failed",
      error_message: anySuccess ? null : "All notification attempts failed",
    })
    .eq("id", messageId);

  return json(
    {
      success: anySuccess,
      duplicate: false,
      message_id: messageId,
      category: classification.category,
      is_urgent: classification.is_urgent,
      notified,
    },
    anySuccess ? 200 : 502,
  );
});
