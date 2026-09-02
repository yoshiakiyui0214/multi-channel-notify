import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// LINE の userId 取得確認用の一時デバッグ関数。
// 確認が終わったら Supabase ダッシュボードから削除すること。
Deno.serve(async (req: Request) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    console.log("Failed to parse request body as JSON:", err);
    return new Response("OK", { status: 200 });
  }

  console.log("LINE webhook body:", JSON.stringify(body));

  const events = (body as { events?: unknown })?.events;
  if (Array.isArray(events) && events.length > 0) {
    events.forEach((event, i) => {
      const userId = (event as { source?: { userId?: string } })?.source?.userId;
      console.log(`events[${i}].source.userId =`, userId ?? "(not present)");
    });
  } else {
    console.log("No events in request body (likely LINE's webhook verification request)");
  }

  // LINE Platform は 200 以外を受け取るとエラー扱いにするため、常に 200 を返す
  return new Response("OK", { status: 200 });
});
