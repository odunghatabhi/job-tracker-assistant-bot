import { createFileRoute } from "@tanstack/react-router";

// Scheduled scan endpoint. Triggered by pg_cron twice daily.
// Authenticated by Supabase anon key in the `apikey` header (matches pg_net call).
export const Route = createFileRoute("/api/public/cron/scan-all")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!expected || apiKey !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { syncUserGmail } = await import("@/lib/gmail.server");

        const { data: users, error } = await supabaseAdmin
          .from("gmail_sync")
          .select("user_id")
          .eq("scan_enabled", true);
        if (error) return Response.json({ error: error.message }, { status: 500 });

        const results: Record<string, unknown> = {};
        for (const u of users ?? []) {
          try {
            results[u.user_id as string] = await syncUserGmail(u.user_id as string);
          } catch (e) {
            results[u.user_id as string] = {
              error: e instanceof Error ? e.message : "unknown",
            };
          }
        }

        return Response.json({ processed: Object.keys(results).length, results });
      },
    },
  },
});
