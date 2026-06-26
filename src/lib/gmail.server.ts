// Server-only helpers for Gmail API + Gemini classification.
// Filename ends in .server.ts so the bundler refuses any client import.

import { normalize } from "./normalize";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GEMINI_MODEL = "gemini-2.5-flash";

export interface ClassifiedEmail {
  is_job: boolean;
  type: "applied" | "interview" | "offer" | "rejected" | "other";
  company: string | null;
  role: string | null;
  applied_at_iso: string | null;
  confidence: number;
}

export function getOAuthConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.");
  }
  return { clientId, clientSecret };
}

export function getRedirectUri(origin: string): string {
  return `${origin}/api/auth/gmail/callback`;
}

export async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const { clientId, clientSecret } = getOAuthConfig();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
    id_token?: string;
  };
}

export async function refreshAccessToken(refreshToken: string) {
  const { clientId, clientSecret } = getOAuthConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { access_token: string; expires_in: number };
}

export async function getGmailProfile(accessToken: string) {
  const res = await fetch(`${GMAIL_API}/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail profile failed: ${res.status}`);
  return (await res.json()) as { emailAddress: string; historyId: string };
}

export async function listMessageIds(
  accessToken: string,
  query: string,
  maxResults = 50,
): Promise<string[]> {
  const url = new URL(`${GMAIL_API}/messages`);
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(maxResults));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Gmail list failed: ${res.status}`);
  const data = (await res.json()) as { messages?: { id: string }[] };
  return (data.messages ?? []).map((m) => m.id);
}

export interface GmailMessageLite {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  receivedAt: string;
}

export async function getMessageMeta(
  accessToken: string,
  id: string,
): Promise<GmailMessageLite | null> {
  const url = new URL(`${GMAIL_API}/messages/${id}`);
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "Subject");
  url.searchParams.append("metadataHeaders", "From");
  url.searchParams.append("metadataHeaders", "Date");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    id: string;
    snippet?: string;
    internalDate?: string;
    payload?: { headers?: { name: string; value: string }[] };
  };
  const headers = data.payload?.headers ?? [];
  const get = (n: string) =>
    headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const receivedAt = data.internalDate
    ? new Date(Number(data.internalDate)).toISOString()
    : new Date().toISOString();
  return {
    id: data.id,
    subject: get("Subject"),
    from: get("From"),
    snippet: data.snippet ?? "",
    receivedAt,
  };
}

export async function classifyEmails(
  emails: GmailMessageLite[],
): Promise<Record<string, ClassifiedEmail>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
  if (emails.length === 0) return {};

  const prompt = `You analyze emails to detect job application activity. For EACH email below, decide:
- is_job: true only if the email is clearly about the recipient's own job application (application confirmation, interview invite/scheduling, offer, or rejection). Newsletters, job alerts, "jobs you might like" digests, marketing => false.
- type: one of "applied" (application received/confirmation), "interview" (interview invite, scheduling, recruiter screen, assessment), "offer" (job offer extended), "rejected" (no longer moving forward / position filled), "other".
- company: the hiring company name (clean, no suffixes like "Inc.", "Talent Team"). null if unclear.
- role: the job title applied for. null if unclear.
- applied_at_iso: only if this is an "applied" email, the application timestamp (use the email received time if not stated). Otherwise null.
- confidence: 0..1.

Return ONLY a JSON object {"results":[{"id":"...","is_job":..., "type":"...", "company":..., "role":..., "applied_at_iso":..., "confidence":...}, ...]} with one entry per email, in order.

Emails:
${emails
  .map(
    (e, i) =>
      `[${i}] id=${e.id}\nFrom: ${e.from}\nSubject: ${e.subject}\nReceived: ${e.receivedAt}\nSnippet: ${e.snippet}`,
  )
  .join("\n\n")}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  let parsed: { results?: (ClassifiedEmail & { id: string })[] } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  const out: Record<string, ClassifiedEmail> = {};
  for (const r of parsed.results ?? []) {
    out[r.id] = {
      is_job: !!r.is_job,
      type: (r.type ?? "other") as ClassifiedEmail["type"],
      company: r.company ?? null,
      role: r.role ?? null,
      applied_at_iso: r.applied_at_iso ?? null,
      confidence: typeof r.confidence === "number" ? r.confidence : 0,
    };
  }
  return out;
}

// Status precedence: later in array = stronger / final.
const STATUS_RANK: Record<string, number> = {
  other: 0,
  applied: 1,
  interview: 2,
  rejected: 3,
  offer: 4,
};

export function shouldUpgradeStatus(current: string, incoming: string): boolean {
  return (STATUS_RANK[incoming] ?? 0) >= (STATUS_RANK[current] ?? 0);
}

export interface SyncResult {
  scanned: number;
  classified: number;
  created: number;
  updated: number;
  skipped: number;
}

export async function syncUserGmail(userId: string): Promise<SyncResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: sync, error: syncErr } = await supabaseAdmin
    .from("gmail_sync")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (syncErr) throw syncErr;
  if (!sync) throw new Error("Gmail is not connected for this user.");
  if (!sync.scan_enabled) {
    return { scanned: 0, classified: 0, created: 0, updated: 0, skipped: 0 };
  }

  // Refresh access token if missing or near expiry.
  let accessToken = sync.access_token as string | null;
  const expiresAt = sync.access_token_expires_at
    ? new Date(sync.access_token_expires_at as string).getTime()
    : 0;
  if (!accessToken || Date.now() > expiresAt - 60_000) {
    const r = await refreshAccessToken(sync.refresh_token as string);
    accessToken = r.access_token;
    const newExpires = new Date(Date.now() + r.expires_in * 1000).toISOString();
    await supabaseAdmin
      .from("gmail_sync")
      .update({ access_token: accessToken, access_token_expires_at: newExpires })
      .eq("user_id", userId);
  }

  // Search query — keep it broad enough to catch real job-app mail, narrow enough to limit volume.
  const lastSynced = sync.last_synced_at ? new Date(sync.last_synced_at as string) : null;
  const sinceDays = lastSynced
    ? Math.max(1, Math.ceil((Date.now() - lastSynced.getTime()) / 86_400_000) + 1)
    : 30;
  const query = `newer_than:${sinceDays}d (application OR "thank you for applying" OR interview OR "next steps" OR "we regret" OR offer OR recruiter OR "your application")`;

  const ids = await listMessageIds(accessToken!, query, 50);

  // Skip messages already processed
  const { data: existing } = await supabaseAdmin
    .from("email_events")
    .select("gmail_message_id")
    .eq("user_id", userId)
    .in("gmail_message_id", ids.length ? ids : ["__none__"]);
  const seen = new Set((existing ?? []).map((r) => r.gmail_message_id));
  const newIds = ids.filter((id) => !seen.has(id));

  const messages: GmailMessageLite[] = [];
  for (const id of newIds) {
    const m = await getMessageMeta(accessToken!, id);
    if (m) messages.push(m);
  }

  // Classify in batches of 10
  let created = 0;
  let updated = 0;
  let classified = 0;
  let skipped = 0;
  for (let i = 0; i < messages.length; i += 10) {
    const batch = messages.slice(i, i + 10);
    const results = await classifyEmails(batch);
    for (const m of batch) {
      const r = results[m.id];
      if (!r) {
        skipped += 1;
        continue;
      }
      classified += 1;
      if (!r.is_job || !r.company || !r.role) {
        // Still record an event tagged "other" with no application link, so we don't re-scan it.
        await supabaseAdmin.from("email_events").insert({
          user_id: userId,
          application_id: null,
          gmail_message_id: m.id,
          received_at: m.receivedAt,
          type: "other",
          subject: m.subject,
          snippet: m.snippet,
          from_addr: m.from,
        });
        continue;
      }
      const companyNorm = normalize(r.company);
      const roleNorm = normalize(r.role);

      // Find existing app
      const { data: existingApp } = await supabaseAdmin
        .from("applications")
        .select("*")
        .eq("user_id", userId)
        .eq("company_norm", companyNorm)
        .eq("role_norm", roleNorm)
        .maybeSingle();

      let appId: string;
      if (!existingApp) {
        const appliedAt = r.applied_at_iso ?? m.receivedAt;
        const { data: ins, error: insErr } = await supabaseAdmin
          .from("applications")
          .insert({
            user_id: userId,
            company: r.company,
            company_norm: companyNorm,
            role: r.role,
            role_norm: roleNorm,
            applied_at: appliedAt,
            status: r.type === "applied" ? "applied" : r.type,
            last_status_at: m.receivedAt,
            last_email_id: m.id,
            source: "gmail",
          })
          .select("id")
          .single();
        if (insErr) {
          skipped += 1;
          continue;
        }
        appId = ins.id as string;
        created += 1;
      } else {
        appId = existingApp.id as string;
        if (shouldUpgradeStatus(existingApp.status as string, r.type)) {
          await supabaseAdmin
            .from("applications")
            .update({
              status: r.type,
              last_status_at: m.receivedAt,
              last_email_id: m.id,
            })
            .eq("id", appId);
          updated += 1;
        }
      }

      await supabaseAdmin.from("email_events").insert({
        user_id: userId,
        application_id: appId,
        gmail_message_id: m.id,
        received_at: m.receivedAt,
        type: r.type,
        subject: m.subject,
        snippet: m.snippet,
        from_addr: m.from,
      });
    }
  }

  await supabaseAdmin
    .from("gmail_sync")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("user_id", userId);

  return { scanned: ids.length, classified, created, updated, skipped };
}
