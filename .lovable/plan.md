# Job Application Tracker

A dashboard that watches each user's Gmail for job-application messages, uses Gemini to classify them, and keeps a live database of applications (company, role, applied date, current status).

## What the user gets

- **Sign in with Google** — grants the app read-only access to their Gmail.
- **Dashboard** with:
  - Table of applications (Company · Role · Applied at · Status · Last update) with filter, sort, edit, add, delete.
  - Stats cards (Total / Applied / Interview / Offer / Rejected) + a status breakdown chart and an "applications over time" chart.
  - **Sync now** button for on-demand scans (plus automatic 2x/day).
- **Per-application detail drawer** showing the source email subjects/dates Gemini used.

## How it works

```text
Gmail (per user, OAuth offline)
        │
        ▼
 Scan job (2x/day via pg_cron + on-demand)
        │  fetch new messages since last_history_id
        ▼
 Gemini 2.5 Flash (builder's API key)
   classify: applied | interview | offer | rejected | other
   extract:  company, role, applied_at
        │
        ▼
 Postgres
   applications  (one row per company+role)
   email_events  (every classified email, links to application)
   gmail_sync    (per-user tokens + last_history_id + last_synced_at)
```

Status transitions are merged into the existing application row (matched by normalized company + role). New "applied" emails create a row; later "interview/offer/rejected" emails for the same company+role update its status and append an event.

## Technical details

### Auth & Gmail access

- **Lovable Cloud** for auth + database.
- Sign-in: Google OAuth via Lovable broker (email/password also enabled as fallback).
- Separate **Gmail consent flow** (`/connect-gmail`) requesting `gmail.readonly` with `access_type=offline` + `prompt=consent` so we get a **refresh token**. Tokens stored server-side in `gmail_sync` (RLS-locked, service-role for cron).
- Builder provides OAuth client ID/secret as secrets: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`. (You'll need to create an OAuth client in Google Cloud Console — I'll give you the redirect URI to paste.)

### Gemini

- Builder's `GEMINI_API_KEY` stored as a secret.
- Model: `gemini-2.5-flash (user can chose the model)` via Google's REST API.
- One call per email batch returns structured JSON: `{is_job, type, company, role, applied_at_iso, confidence}`.

### Database (Postgres, RLS on)

- `applications` — id, user_id, company, role, applied_at, status, last_status_at, last_email_id, notes.
- `email_events` — id, user_id, application_id, gmail_message_id, received_at, type, subject, snippet.
- `gmail_sync` — user_id (PK), refresh_token, access_token, access_token_expires_at, last_history_id, last_synced_at, scan_enabled.

### Scanning

- Server function `scanGmailForUser(userId)`:
  1. Refresh access token if expired.
  2. Use Gmail `users.history.list` from `last_history_id` (or `users.messages.list?q=newer_than:30d category:primary` on first run).
  3. For each new message → fetch headers + snippet → batch into Gemini → upsert applications + insert events.
  4. Update `last_history_id` and `last_synced_at`.
- **Sync now** button calls it for the current user.
- **pg_cron** runs twice daily (08:00 and 20:00 UTC — configurable) and POSTs to a public server route `/api/public/cron/scan-all` (HMAC-protected with `CRON_SECRET`) that iterates users with `scan_enabled=true`.

### Stack

- TanStack Start server functions for app-internal calls (`scanGmail`, CRUD).
- Server route `src/routes/api/public/cron/scan-all.ts` for the scheduled trigger.
- Server route `src/routes/api/auth/gmail/callback.ts` for the Gmail OAuth callback.
- Frontend: shadcn table, recharts for the status/time charts.

## What I need from you before / during the build

1. **OAuth credentials** — after I scaffold the app I'll give you the exact redirect URI; you create an OAuth 2.0 Web Client in Google Cloud Console (Gmail API enabled), then paste the Client ID and Secret into the secret prompt.
2. **Gemini API key** — I'll prompt for `GEMINI_API_KEY`.

## Scope this plan does NOT include

- Email timeline view per application (you didn't pick it — easy to add later; events are stored either way).
- Sending email replies, calendar integration, resume parsing.
- Multi-account Gmail per user.

Approve and I'll start building: Cloud + schema first, then auth, then the Gmail/Gemini scan, then the dashboard.