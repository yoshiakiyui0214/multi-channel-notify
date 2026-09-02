import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GMAIL_MAX_RESULTS_DEFAULT = 10;
const GMAIL_MAX_RESULTS_LIMIT = 50;
const GMAIL_QUERY = "in:inbox is:unread";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Gmail のメッセージ本文・添付ヘッダーは base64url (- _) で届くが、
// MIMEエンコードワード (RFC 2047) は標準 base64 (+ /) を使うため、両対応で正規化する。
function decodeBase64ToUtf8(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // atob → 文字コード配列 → TextDecoder という経路を通すことで、
  // 日本語などマルチバイト文字の文字化けを避ける (単純な atob + decodeURIComponent は避ける)
  return new TextDecoder("utf-8").decode(bytes);
}

// RFC 2047 エンコードワード ("=?UTF-8?B?...?=" / "=?UTF-8?Q?...?=") をデコードする。
// 件名・送信者名(Fromヘッダーの表示名)は日本語がこの形式でエンコードされていることが多い。
function decodeMimeHeader(value: string): string {
  const encodedWordRe = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  return value.replace(encodedWordRe, (match, charset, encoding, encodedText) => {
    try {
      if (encoding.toLowerCase() === "b") {
        return decodeBase64ToUtf8(encodedText);
      }
      const qDecoded = encodedText.replace(/_/g, " ");
      const bytes: number[] = [];
      for (let i = 0; i < qDecoded.length; i++) {
        if (qDecoded[i] === "=") {
          bytes.push(parseInt(qDecoded.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(qDecoded.charCodeAt(i));
        }
      }
      return new TextDecoder(charset || "utf-8").decode(new Uint8Array(bytes));
    } catch {
      return match;
    }
  });
}

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Secret GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN is not set",
    );
  }

  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch (err) {
    throw new Error(`Request to Google token endpoint failed: ${err}`);
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  if (typeof data.access_token !== "string") {
    throw new Error("Google token response did not include access_token");
  }
  return data.access_token;
}

interface GmailMessageListItem {
  id: string;
  threadId: string;
}

async function listUnreadMessages(
  accessToken: string,
  maxResults: number,
): Promise<GmailMessageListItem[]> {
  const url = new URL(`${GMAIL_API_BASE}/messages`);
  url.searchParams.set("q", GMAIL_QUERY);
  url.searchParams.set("maxResults", String(maxResults));

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gmail messages.list failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  return Array.isArray(data.messages) ? data.messages : [];
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string };
  parts?: GmailPart[];
}

interface GmailMessageFull {
  id: string;
  internalDate?: string;
  payload?: GmailPart;
}

async function getMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageFull> {
  const url = `${GMAIL_API_BASE}/messages/${messageId}?format=full`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gmail messages.get failed (${res.status}): ${detail}`);
  }

  return await res.json();
}

async function markAsRead(accessToken: string, messageId: string): Promise<void> {
  const url = `${GMAIL_API_BASE}/messages/${messageId}/modify`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gmail messages.modify failed (${res.status}): ${detail}`);
  }
}

function getHeader(headers: GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function parseSender(fromHeader: string): { email: string; name: string | null } {
  const decoded = decodeMimeHeader(fromHeader);
  const match = decoded.match(/^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/);
  if (match) {
    const name = match[1].trim();
    return { email: match[2].trim(), name: name.length > 0 ? name : null };
  }
  return { email: decoded.trim(), name: null };
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// text/plain を優先し、無ければ text/html をタグ除去して使う (multipart を再帰探索)
function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return "";

  let plainText: string | null = null;
  let htmlText: string | null = null;

  function walk(part: GmailPart) {
    const mimeType = part.mimeType ?? "";
    if (mimeType === "text/plain" && part.body?.data && plainText === null) {
      plainText = decodeBase64ToUtf8(part.body.data);
    } else if (mimeType === "text/html" && part.body?.data && htmlText === null) {
      htmlText = decodeBase64ToUtf8(part.body.data);
    }
    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  }

  walk(payload);

  if (plainText !== null) return (plainText as string).trim();
  if (htmlText !== null) return stripHtml(htmlText as string);
  return "";
}

interface ProcessResult {
  gmail_message_id: string;
  status: "notified" | "duplicate" | "failed" | "mark_read_failed";
  error?: string;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const maxParam = parseInt(url.searchParams.get("max") ?? "", 10);
  const maxResults = Number.isFinite(maxParam)
    ? Math.min(Math.max(maxParam, 1), GMAIL_MAX_RESULTS_LIMIT)
    : GMAIL_MAX_RESULTS_DEFAULT;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json(
      { success: false, error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is not set" },
      500,
    );
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    return json({ success: false, error: `${err}` }, 500);
  }

  let listItems: GmailMessageListItem[];
  try {
    listItems = await listUnreadMessages(accessToken, maxResults);
  } catch (err) {
    return json({ success: false, error: `${err}` }, 500);
  }

  const classifyAndNotifyUrl = `${supabaseUrl}/functions/v1/classify-and-notify`;
  const results: ProcessResult[] = [];

  for (const item of listItems) {
    let message: GmailMessageFull;
    try {
      message = await getMessage(accessToken, item.id);
    } catch (err) {
      results.push({ gmail_message_id: item.id, status: "failed", error: `${err}` });
      continue;
    }

    const headers = message.payload?.headers;
    const fromHeader = getHeader(headers, "From");
    if (!fromHeader) {
      results.push({
        gmail_message_id: item.id,
        status: "failed",
        error: "Missing From header",
      });
      continue;
    }

    const subjectHeader = getHeader(headers, "Subject");
    const { email: senderEmail, name: senderName } = parseSender(fromHeader);
    const subject = subjectHeader ? decodeMimeHeader(subjectHeader) : null;
    const body = extractBody(message.payload);
    const receivedAt = message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : new Date().toISOString();

    if (!body) {
      results.push({
        gmail_message_id: item.id,
        status: "failed",
        error: "Empty message body",
      });
      continue;
    }

    let notifyRes: Response;
    try {
      notifyRes = await fetch(classifyAndNotifyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({
          source_channel: "email",
          external_id: item.id,
          sender: senderEmail,
          sender_name: senderName,
          subject,
          body,
          received_at: receivedAt,
        }),
      });
    } catch (err) {
      results.push({
        gmail_message_id: item.id,
        status: "failed",
        error: `Request to classify-and-notify failed: ${err}`,
      });
      continue;
    }

    if (!notifyRes.ok) {
      const detail = await notifyRes.text();
      results.push({
        gmail_message_id: item.id,
        status: "failed",
        error: `classify-and-notify responded ${notifyRes.status}: ${detail}`,
      });
      continue;
    }

    const notifyData = await notifyRes.json().catch(() => null);

    // classify-and-notify が正常応答した場合のみ既読化する。
    // 未読のまま残せば次回実行時に自然にリトライされ、
    // external_id の一意制約により重複した分類・通知は発生しない。
    try {
      await markAsRead(accessToken, item.id);
    } catch (err) {
      results.push({
        gmail_message_id: item.id,
        status: "mark_read_failed",
        error: `${err}`,
      });
      continue;
    }

    results.push({
      gmail_message_id: item.id,
      status: notifyData?.duplicate ? "duplicate" : "notified",
    });
  }

  const failed = results.filter((r) => r.status === "failed").length;

  return json(
    {
      success: failed === 0,
      fetched: listItems.length,
      failed,
      results,
    },
    failed > 0 && failed === listItems.length ? 502 : 200,
  );
});
