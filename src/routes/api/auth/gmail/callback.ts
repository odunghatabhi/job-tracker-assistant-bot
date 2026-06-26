import { createFileRoute } from "@tanstack/react-router";
import {
  exchangeCodeForTokens,
  getGmailProfile,
  getRedirectUri,
} from "@/lib/gmail.server";

export const Route = createFileRoute("/api/auth/gmail/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        if (error) return Response.redirect(`${url.origin}/dashboard?gmail=error&reason=${encodeURIComponent(error)}`, 302);
        if (!code || !state) return new Response("Missing code/state", { status: 400 });

        try {
          const tokens = await exchangeCodeForTokens(code, getRedirectUri(url.origin));
          if (!tokens.refresh_token) {
            return Response.redirect(
              `${url.origin}/dashboard?gmail=error&reason=${encodeURIComponent("no_refresh_token")}`,
              302,
            );
          }
          const profile = await getGmailProfile(tokens.access_token);
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

          await supabaseAdmin.from("gmail_sync").upsert(
            {
              user_id: state,
              gmail_address: profile.emailAddress,
              refresh_token: tokens.refresh_token,
              access_token: tokens.access_token,
              access_token_expires_at: expiresAt,
              scan_enabled: true,
            },
            { onConflict: "user_id" },
          );

          return Response.redirect(`${url.origin}/dashboard?gmail=connected`, 302);
        } catch (e) {
          const msg = e instanceof Error ? e.message : "unknown";
          return Response.redirect(`${url.origin}/dashboard?gmail=error&reason=${encodeURIComponent(msg)}`, 302);
        }
      },
    },
  },
});
