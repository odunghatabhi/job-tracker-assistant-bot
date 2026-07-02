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
  recruiter: string | null;
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

type ApplicationRow = {
  id: string;
  company: string;
  company_norm: string;
  role: string;
  role_norm: string;
  applied_at: string;
  status: string;
  last_status_at: string;
  last_email_id?: string | null;
};

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

  const prompt = `You are a strict multilingual classifier of job-application emails (English AND German — Bewerbung, Vorstellungsgespräch, Absage, Zusage, etc.). For EACH email below, decide:
- is_job: true if the email is about the recipient's own job application lifecycle — application confirmation, interview invite/scheduling/reschedule, recruiter screen, online assessment, take-home, offer, OR rejection. Newsletters, job alerts, "jobs you might like", marketing, generic recruiter outreach with no specific application => false.
- type: EXACTLY one of:
  * "applied"   — application received / "thank you for applying" / "Eingangsbestätigung" / "Vielen Dank für Ihre Bewerbung".
  * "interview" — interview invite, scheduling, recruiter screen, assessment, take-home, "next steps" / "Einladung zum Vorstellungsgespräch" / "Kennenlerngespräch" / "nächste Schritte".
  * "offer"     — formal job offer / "Vertragsangebot" / "Zusage" / "Angebot".
  * "rejected"  — application unsuccessful. English: "unfortunately", "we regret", "not moving forward", "other candidates", "position has been filled", "not selected", "will not be proceeding", "no longer under consideration". German: "leider", "Absage", "haben wir uns gegen Sie entschieden", "andere Bewerber", "nicht weiter berücksichtigen", "nicht in die engere Auswahl", "Ihre Bewerbung nicht weiterverfolgen".
  * "other"     — anything else.
  Bias toward "rejected" when the email is clearly negative about the recipient's application, in any language.
- company: hiring company name only — NOT the applicant-tracking platform. If sender/body mentions Workday, Greenhouse, Lever, Personio, SmartRecruiters, Teamtailor, Ashby, Recruitee, Taleo, SuccessFactors, BambooHR, or Workable, extract the employer/customer company instead. Strip suffixes ("Inc.", "GmbH", "AG", "Talent Acquisition", "Recruiting", "Careers", "Personalabteilung"). For staffing/consulting agencies (Ferchau, Alten, Hays, Randstad, Adecco, Brunel, GULP, Amadeus Fire, Michael Page, Robert Half, Modis, Akkodis) — the agency IS the company. null only if truly unknown.
- role: the job title. For status updates without a role in this email, try subject ("Your application for X" / "Ihre Bewerbung als X"), otherwise null — do not invent.
- recruiter: the sender's personal name if the email is signed by an individual recruiter (e.g. "Anna Müller"), especially for staffing agencies. null if none/generic.
- applied_at_iso: only for type="applied". Use the email received time if not stated. Otherwise null.
- confidence: 0..1. Use >=0.6 when subject/body clearly states the outcome.

Return ONLY a JSON object: {"results":[{"id":"...","is_job":true,"type":"...","company":"...","role":"...","recruiter":null,"applied_at_iso":null,"confidence":0.9}, ...]} — one entry per email, in order.

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
      recruiter: (r as any).recruiter ?? null,
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

function isStatusUpdateType(type: string): boolean {
  return type === "interview" || type === "offer" || type === "rejected";
}

const COMPANY_STOPWORDS = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "gmbh", "ag", "se", "sa", "sas", "bv", "nv",
  "kg", "ohg", "ug", "co", "company", "group", "holding", "holdings", "careers", "career", "jobs",
  "job", "recruiting", "recruitment", "talent", "acquisition", "personalabteilung", "personal", "hr",
  "human", "resources", "team", "noreply", "reply", "workday", "greenhouse", "lever", "smartrecruiters",
  "smart", "recruiters", "personio", "ashby", "recruitee", "taleo", "successfactors", "success",
  "factors", "bamboohr", "bamboo", "workable", "teamtailor", "join", "mail", "email", "com", "de",
  "eu", "io", "net", "org",
]);

const ROLE_STOPWORDS = new Set([
  "job", "role", "position", "application", "bewerbung", "stelle", "stellenangebot", "als", "fur", "for",
  "the", "and", "und", "m", "w", "d", "f", "x", "all", "gender", "remote", "hybrid", "onsite",
]);

function tokenSet(value: string | null | undefined, stopwords = new Set<string>()): Set<string> {
  return new Set(
    normalize(value)
      .split(/\s+/)
      .filter((token) => token.length > 1 && !stopwords.has(token)),
  );
}

function overlapScore(aValue: string | null | undefined, bValue: string | null | undefined, stopwords: Set<string>): number {
  const a = tokenSet(aValue, stopwords);
  const b = tokenSet(bValue, stopwords);
  if (!a.size || !b.size) return 0;
  const aText = [...a].join(" ");
  const bText = [...b].join(" ");
  if (aText === bText || aText.includes(bText) || bText.includes(aText)) return 1;
  let hits = 0;
  for (const token of a) if (b.has(token)) hits += 1;
  return hits / Math.min(a.size, b.size);
}

function normalizedEmailText(message: GmailMessageLite): string {
  return normalize(`${message.from}\n${message.subject}\n${message.snippet}`);
}

function emailDomainTokens(from: string): Set<string> {
  const domain = from.match(/@([^>\s]+)/)?.[1]?.split("@").pop() ?? "";
  const withoutTld = domain.split(".").slice(0, -1).join(" ").replace(/[-_]/g, " ");
  return tokenSet(withoutTld, COMPANY_STOPWORDS);
}

function extractSenderName(from: string): string | null {
  // "Anna Müller <a.mueller@ferchau.com>" -> "Anna Müller"
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  const name = (m?.[1] ?? "").trim();
  if (!name || name.includes("@")) return null;
  // Skip generic team names
  const lower = name.toLowerCase();
  if (/(no[- ]?reply|team|recruiting|talent|careers|hr|human resources|personal|notification)/.test(lower)) return null;
  return name;
}

function messageMentionsCompany(app: ApplicationRow, normalizedText: string): boolean {
  const companyText = normalize(app.company);
  if (companyText.length >= 4 && normalizedText.includes(companyText)) return true;
  const tokens = [...tokenSet(app.company, COMPANY_STOPWORDS)].filter((token) => token.length >= 4);
  if (!tokens.length) return false;
  const hits = tokens.filter((token) => normalizedText.includes(token)).length;
  return hits >= Math.min(2, tokens.length);
}

function detectLifecycleType(message: GmailMessageLite): ClassifiedEmail["type"] | null {
  const text = normalizedEmailText(message);
  const has = (...phrases: string[]) => phrases.some((phrase) => text.includes(normalize(phrase)));
  if (has(
    "not moving forward", "moving forward with other candidates", "other candidates", "not selected",
    "will not be proceeding", "no longer under consideration", "position has been filled", "we regret",
    "unfortunately", "unsuccessful", "leider", "absage", "nicht weiter berucksichtigen",
    "nicht berucksichtigen", "nicht in die engere auswahl", "gegen sie entschieden", "andere bewerber",
    "andere kandidaten", "bewerbung nicht weiterverfolgen", "konnen ihnen keine positive ruckmeldung",
  )) return "rejected";
  if (has(
    "interview", "recruiter screen", "phone screen", "next steps", "schedule a call", "assessment",
    "take home", "vorstellungsgesprach", "kennenlerngesprach", "gesprach", "termin", "nachste schritte",
  )) return "interview";
  if (has("offer", "job offer", "employment offer", "vertragsangebot", "zusage", "angebot")) return "offer";
  if (has(
    "thank you for applying", "your application has been received", "application received", "we received your application",
    "vielen dank fur ihre bewerbung", "bewerbung erhalten", "eingangsbestatigung", "haben ihre bewerbung erhalten",
  )) return "applied";
  return null;
}

function enhanceClassification(message: GmailMessageLite, result?: ClassifiedEmail): ClassifiedEmail {
  const forcedType = detectLifecycleType(message);
  const base: ClassifiedEmail = result ?? {
    is_job: false,
    type: "other",
    company: null,
    role: null,
    recruiter: null,
    applied_at_iso: null,
    confidence: 0,
  };
  if (!forcedType) return base;
  if (forcedType === "rejected" || !base.is_job || base.type === "other" || base.confidence < 0.7) {
    return {
      ...base,
      is_job: true,
      type: forcedType,
      confidence: Math.max(base.confidence, forcedType === "rejected" ? 0.9 : 0.78),
    };
  }
  return base;
}

function findBestApplication(apps: ApplicationRow[], result: ClassifiedEmail, message: GmailMessageLite): ApplicationRow | null {
  if (!apps.length) return null;
  const text = normalizedEmailText(message);
  const domainTokens = emailDomainTokens(message.from);
  const incomingAt = new Date(message.receivedAt).getTime();
  const scored = apps
    .map((app) => {
      const companyScore = result.company ? overlapScore(result.company, app.company, COMPANY_STOPWORDS) : 0;
      const mentionedCompany = messageMentionsCompany(app, text);
      const appCompanyTokens = tokenSet(app.company, COMPANY_STOPWORDS);
      let domainHits = 0;
      for (const token of domainTokens) if (appCompanyTokens.has(token)) domainHits += 1;
      const domainScore = domainTokens.size && appCompanyTokens.size ? domainHits / Math.min(domainTokens.size, appCompanyTokens.size) : 0;

      if (companyScore < 0.5 && !mentionedCompany && domainScore < 0.75) return null;

      const roleScore = result.role ? overlapScore(result.role, app.role, ROLE_STOPWORDS) : 0;
      const recruiterScore = result.recruiter ? overlapScore(result.recruiter, app.role, ROLE_STOPWORDS) : 0;
      const effectiveRoleScore = Math.max(roleScore, recruiterScore);
      if (result.role && roleScore < 0.35 && recruiterScore < 0.5 && !isStatusUpdateType(result.type)) return null;

      const appliedAt = new Date(app.applied_at).getTime();
      const daysSinceApplied = Math.max(0, (incomingAt - appliedAt) / 86_400_000);
      const statusAfterApplicationBonus = appliedAt <= incomingAt + 2 * 86_400_000 ? 1.25 : -2;
      const recencyPenalty = Math.min(2, daysSinceApplied / 120);
      const score =
        companyScore * 6 +
        (mentionedCompany ? 3 : 0) +
        domainScore * 2 +
        effectiveRoleScore * 3 +
        statusAfterApplicationBonus -
        recencyPenalty;
      return { app, score };
    })
    .filter((row): row is { app: ApplicationRow; score: number } => !!row)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;
  return best.score >= (result.company ? 3.5 : 3.25) ? best.app : null;
}

function shouldApplyStatusUpdate(app: ApplicationRow, incomingType: string, receivedAt: string): boolean {
  if (!isStatusUpdateType(incomingType)) return false;
  const incomingTime = new Date(receivedAt).getTime();
  const currentTime = new Date(app.last_status_at).getTime();
  const incomingRank = STATUS_RANK[incomingType] ?? 0;
  const currentRank = STATUS_RANK[app.status] ?? 0;
  return incomingTime >= currentTime || incomingRank > currentRank;
}

async function reconcileUnlinkedEvents(
  supabaseAdmin: any,
  userId: string,
  knownApps: ApplicationRow[],
): Promise<{ classified: number; updated: number; skipped: number }> {
  const cutoff = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const { data: events } = await supabaseAdmin
    .from("email_events")
    .select("id,gmail_message_id,received_at,type,subject,snippet,from_addr")
    .eq("user_id", userId)
    .is("application_id", null)
    .gte("received_at", cutoff)
    .order("received_at", { ascending: true })
    .limit(120);

  const eventRows = (events ?? []) as any[];
  const messages: GmailMessageLite[] = eventRows.map((event: any) => ({
    id: event.gmail_message_id,
    subject: event.subject ?? "",
    from: event.from_addr ?? "",
    snippet: event.snippet ?? "",
    receivedAt: event.received_at,
  }));

  let classified = 0;
  let updated = 0;
  let skipped = 0;
  for (let i = 0; i < messages.length; i += 10) {
    const batch = messages.slice(i, i + 10);
    const results = await classifyEmails(batch);
    for (let j = 0; j < batch.length; j += 1) {
      const message = batch[j];
      const event = eventRows[i + j];
      const result = enhanceClassification(message, results[message.id]);
      classified += 1;
      if (!result.is_job || result.type === "other") {
        skipped += 1;
        continue;
      }
      const app = findBestApplication(knownApps, result, message);
      if (!app) {
        skipped += 1;
        continue;
      }
      await supabaseAdmin
        .from("email_events")
        .update({ application_id: app.id, type: result.type })
        .eq("id", event.id)
        .eq("user_id", userId);
      if (shouldApplyStatusUpdate(app, result.type, message.receivedAt)) {
        await supabaseAdmin
          .from("applications")
          .update({ status: result.type, last_status_at: message.receivedAt, last_email_id: message.id })
          .eq("id", app.id)
          .eq("user_id", userId);
        app.status = result.type;
        app.last_status_at = message.receivedAt;
        app.last_email_id = message.id;
        updated += 1;
      }
    }
  }
  return { classified, updated, skipped };
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
    ? Math.max(45, Math.ceil((Date.now() - lastSynced.getTime()) / 86_400_000) + 7)
    : 180;
  const query = `newer_than:${sinceDays}d (` +
    // English
    `application OR "thank you for applying" OR "your application" OR ` +
    `interview OR "next steps" OR "online assessment" OR "take home" OR assessment OR ` +
    `offer OR ` +
    `"we regret" OR "unfortunately" OR "not moving forward" OR "position has been filled" OR ` +
    `"other candidates" OR "not selected" OR "will not be proceeding" OR ` +
    `"no longer under consideration" OR rejected OR ` +
    `recruiter OR hiring OR ` +
    // German
    `Bewerbung OR Eingangsbestätigung OR "Vielen Dank für Ihre Bewerbung" OR ` +
    `Vorstellungsgespräch OR Kennenlerngespräch OR Interview OR "nächste Schritte" OR ` +
    `Zusage OR Vertragsangebot OR Angebot OR ` +
    `Absage OR leider OR "andere Bewerber" OR "nicht berücksichtigen" OR "engere Auswahl" OR ` +
    `Personalabteilung OR Recruiting` +
    `)`;

  const ids = await listMessageIds(accessToken!, query, 200);

  // Skip messages already processed
  const { data: existing } = await supabaseAdmin
    .from("email_events")
    .select("gmail_message_id")
    .eq("user_id", userId)
    .in("gmail_message_id", ids.length ? ids : ["__none__"]);
  const seen = new Set((existing ?? []).map((r) => r.gmail_message_id));
  const newIds = ids.filter((id) => !seen.has(id));

  // Fetch message bodies in parallel chunks (much faster than sequential).
  const messages: GmailMessageLite[] = [];
  const CHUNK = 10;
  for (let i = 0; i < newIds.length; i += CHUNK) {
    const chunk = newIds.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map((id) => getMessageMeta(accessToken!, id)));
    for (const m of results) if (m) messages.push(m);
  }
  messages.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());

  const { data: existingApps } = await supabaseAdmin
    .from("applications")
    .select("*")
    .eq("user_id", userId)
    .order("applied_at", { ascending: false })
    .limit(500);
  const knownApps = ((existingApps ?? []) as ApplicationRow[]).slice();

  // Classify in batches of 10
  let created = 0;
  let updated = 0;
  let classified = 0;
  let skipped = 0;
  for (let i = 0; i < messages.length; i += 10) {
    const batch = messages.slice(i, i + 10);
    const results = await classifyEmails(batch);
    for (const m of batch) {
      const r = enhanceClassification(m, results[m.id]);
      if (!r) {
        skipped += 1;
        continue;
      }
      classified += 1;

      // Not a job email at all → record as "other" so we don't reprocess.
      if (!r.is_job || (!r.company && !isStatusUpdateType(r.type))) {
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

      const senderName = extractSenderName(m.from);
      const recruiter = r.recruiter ?? senderName;
      // For staffing agencies without a job title, use recruiter name so multiple applications stay distinct.
      const effectiveRole = r.role ?? (recruiter ? `Recruiter: ${recruiter}` : null);
      const companyNorm = r.company ? normalize(r.company) : "";
      const roleNorm = effectiveRole ? normalize(effectiveRole) : null;
      // Pass recruiter into matcher via a shallow copy so findBestApplication sees it.
      const matchResult: ClassifiedEmail = { ...r, recruiter };
      const existingApp = findBestApplication(knownApps, matchResult, m);

      let appId: string;
      if (!existingApp) {
        // Only CREATE new applications for "applied" emails. Status updates without a match
        // become unlinked events — reconciled later once the "applied" arrives.
        if (r.type !== "applied" || !r.company || !roleNorm) {
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
            role: effectiveRole!,
            role_norm: roleNorm!,
            applied_at: appliedAt,
            status: "applied",
            last_status_at: m.receivedAt,
            last_email_id: m.id,
            source: "gmail",
          })
          .select("*")
          .single();
        if (insErr) {
          skipped += 1;
          continue;
        }
        appId = ins.id as string;
        knownApps.unshift(ins as ApplicationRow);
        created += 1;
      } else {
        appId = existingApp.id as string;
        if (shouldApplyStatusUpdate(existingApp, r.type, m.receivedAt)) {
          await supabaseAdmin
            .from("applications")
            .update({
              status: r.type,
              last_status_at: m.receivedAt,
              last_email_id: m.id,
            })
            .eq("id", appId);
          existingApp.status = r.type;
          existingApp.last_status_at = m.receivedAt;
          existingApp.last_email_id = m.id;
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

  const repaired = await reconcileUnlinkedEvents(supabaseAdmin, userId, knownApps);
  classified += repaired.classified;
  updated += repaired.updated;
  skipped += repaired.skipped;


  await supabaseAdmin
    .from("gmail_sync")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("user_id", userId);

  return { scanned: ids.length, classified, created, updated, skipped };
}
