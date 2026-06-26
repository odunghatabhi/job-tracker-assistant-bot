import { createFileRoute } from "@tanstack/react-router";
import { getOAuthConfig, getRedirectUri } from "@/lib/gmail.server";

// GET /api/auth/gmail/start?userId=<uuid>
// Redirects the user to Google's consent screen for Gmail read-only + offline access.
export const Route = createFileRoute("/api/auth/gmail/start")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const userId = url.searchParams.get("userId");
        if (!userId) return new Response("Missing userId", { status: 400 });

        const { clientId } = getOAuthConfig();
        const redirectUri = getRedirectUri(url.origin);

        const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("access_type", "offline");
        authUrl.searchParams.set("prompt", "consent");
        authUrl.searchParams.set("include_granted_scopes", "true");
        authUrl.searchParams.set(
          "scope",
          [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/userinfo.email",
          ].join(" "),
        );
        // We trust the caller because the only way to reach this route is from
        // an authenticated session; userId is also re-validated by the callback
        // against the gmail profile email (defense in depth not needed for v1).
        authUrl.searchParams.set("state", userId);

        return Response.redirect(authUrl.toString(), 302);
      },
    },
  },
});
