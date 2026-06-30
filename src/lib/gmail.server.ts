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

function decodeBase64Url(s: string): string {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    // atob is available in the Worker runtime
    const bin = atob(b64);
    // Decode as UTF-8
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

function extractBody(payload: any): string {
  if (!payload) return "";
  const parts: any[] = [];
  const walk = (p: any) => {
    if (!p) return;
    if (p.body?.data) parts.push({ mime: p.mimeType, data: p.body.data });
    if (Array.isArray(p.parts)) p.parts.forEach(walk);
  };
  walk(payload);
  // Prefer text/plain, fall back to text/html stripped.
  const plain = parts.find((p) => p.mime === "text/plain");
  if (plain) return decodeBase64Url(plain.data);
  const html = parts.find((p) => p.mime === "text/html");
  if (html) return decodeBase64Url(html.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  if (parts[0]) return decodeBase64Url(parts[0].data);
  return "";
}

export async function getMessageMeta(
  accessToken: string,
  id: string,
): Promise<GmailMessageLite | null> {
  // Fetch full so we can read body text (rejection signals are often only in the body).
  const url = new URL(`${GMAIL_API}/messages/${id}`);
  url.searchParams.set("format", "full");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    id: string;
    snippet?: string;
    internalDate?: string;
    payload?: { headers?: { name: string; value: string }[]; body?: any; parts?: any[]; mimeType?: string };
  };
  const headers = data.payload?.headers ?? [];
  const get = (n: string) =>
    headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const receivedAt = data.internalDate
    ? new Date(Number(data.internalDate)).toISOString()
    : new Date().toISOString();
  const body = extractBody(data.payload).slice(0, 2000);
  const snippet = (data.snippet ?? "") + (body ? "\n" + body : "");
  return {
    id: data.id,
    subject: get("Subject"),
    from: get("From"),
    snippet: snippet.slice(0, 2500),
    receivedAt,
  };
}

export async function classifyEmails(
  emails: GmailMessageLite[],
): Promise<Record<string, ClassifiedEmail>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
  if (emails.length === 0) return {};

  const prompt = `You are a strict classifier of job-application emails. For EACH email below, decide:
- is_job: true if the email is about the recipient's own job application lifecycle — application confirmation, interview invite/scheduling/reschedule, recruiter screen, online assessment, take-home, offer, OR rejection / "not moving forward" / "position filled" / "decided to pursue other candidates" / "unfortunately ... not selected". Newsletters, job alerts, "jobs you might like", marketing, generic recruiter outreach with no specific application => false.
- type: EXACTLY one of:
  * "applied"   — application received / "thank you for applying" / confirmation that an application was submitted.
  * "interview" — interview invite, scheduling link, recruiter screen, technical/online assessment, take-home, hiring manager call, "next steps".
  * "offer"     — a formal job offer is being extended.
  * "rejected"  — application unsuccessful. Signals include: "unfortunately", "we regret", "not moving forward", "decided to move forward with other candidates", "position has been filled", "not selected", "will not be proceeding", "no longer under consideration".
  * "other"     — anything else, including pure marketing or generic job alerts.
  Bias toward "rejected" when the email is clearly negative about the recipient's application even if the company doesn't explicitly say "rejected".
- company: hiring company name only — strip suffixes ("Inc.", "Talent Acquisition Team", "Recruiting", "Careers"). Extract from From domain or signature if needed. null only if truly unknown.
- role: the job title. For status updates (interview/offer/rejected), if the role is not in this email, still try to infer from subject ("Your application for X"), otherwise null — DO NOT invent.
- applied_at_iso: only for type="applied". Use the email received time if not stated. Otherwise null.
- confidence: 0..1. Use >=0.6 when subject/body clearly states the outcome.

Return ONLY a JSON object: {"results":[{"id":"...","is_job":true,"type":"...","company":"...","role":"...","applied_at_iso":null,"confidence":0.9}, ...]} — one entry per email, in order.

Emails:
${emails
  .map(
    (e, i) =>
      `[${i}] id=${e.id}\nFrom: ${e.from}\nSubject: ${e.subject}\nReceived: ${e.receivedAt}\nBody: ${e.snippet}`,
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
  const query = `newer_than:${sinceDays}d (` +
    `application OR "thank you for applying" OR "your application" OR ` +
    `interview OR "next steps" OR "online assessment" OR "take home" OR assessment OR ` +
    `offer OR ` +
    `"we regret" OR "unfortunately" OR "not moving forward" OR "position has been filled" OR ` +
    `"other candidates" OR "not selected" OR "will not be proceeding" OR ` +
    `"no longer under consideration" OR rejected OR ` +
    `recruiter OR hiring` +
    `)`;

  const ids = await listMessageIds(accessToken!, query, 150);

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

      // Not a job email at all → record as "other" so we don't reprocess.
      if (!r.is_job || !r.company) {
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
      const roleNorm = r.role ? normalize(r.role) : null;
      const isStatusUpdate = r.type === "interview" || r.type === "offer" || r.type === "rejected";

      // Find existing app. Prefer exact (company+role) match; for status updates
      // without a role, fall back to most-recent app for this company.
      let existingApp: any = null;
      if (roleNorm) {
        const { data } = await supabaseAdmin
          .from("applications")
          .select("*")
          .eq("user_id", userId)
          .eq("company_norm", companyNorm)
          .eq("role_norm", roleNorm)
          .maybeSingle();
        existingApp = data;
      }
      if (!existingApp && isStatusUpdate) {
        const { data } = await supabaseAdmin
          .from("applications")
          .select("*")
          .eq("user_id", userId)
          .eq("company_norm", companyNorm)
          .order("applied_at", { ascending: false })
          .limit(1);
        existingApp = data?.[0] ?? null;
      }

      let appId: string;
      if (!existingApp) {
        // Need a role to create a new row. Skip status-update emails for unknown apps.
        if (!roleNorm) {
          await supabaseAdmin.from("email_events").insert({
            user_id: userId,
            application_id: null,
            gmail_message_id: m.id,
            received_at: m.receivedAt,
            type: r.type,
            subject: m.subject,
            snippet: m.snippet,
            from_addr: m.from,
          });
          continue;
        }
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
            status: r.type === "other" ? "applied" : r.type,
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
        // Recency wins: any newer status email overrides the stored status
        // (except "other" / "applied" which never overrides a later stage).
        const incomingTime = new Date(m.receivedAt).getTime();
        const currentTime = new Date(existingApp.last_status_at as string).getTime();
        const incomingRank = STATUS_RANK[r.type] ?? 0;
        const currentRank = STATUS_RANK[existingApp.status as string] ?? 0;
        const shouldUpdate =
          isStatusUpdate &&
          (incomingTime >= currentTime || incomingRank > currentRank);
        if (shouldUpdate) {
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
