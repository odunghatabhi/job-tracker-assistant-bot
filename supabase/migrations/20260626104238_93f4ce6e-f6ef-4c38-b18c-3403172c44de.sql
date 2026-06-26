
-- Enum for application status
CREATE TYPE public.application_status AS ENUM ('applied','interview','offer','rejected','other');

-- applications
CREATE TABLE public.applications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company TEXT NOT NULL,
  company_norm TEXT NOT NULL,
  role TEXT NOT NULL,
  role_norm TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  status public.application_status NOT NULL DEFAULT 'applied',
  last_status_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_email_id TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'gmail',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_norm, role_norm)
);
CREATE INDEX idx_applications_user ON public.applications(user_id, applied_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.applications TO authenticated;
GRANT ALL ON public.applications TO service_role;
ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own applications" ON public.applications FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- email_events
CREATE TABLE public.email_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  application_id UUID REFERENCES public.applications(id) ON DELETE SET NULL,
  gmail_message_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  type public.application_status NOT NULL,
  subject TEXT,
  snippet TEXT,
  from_addr TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, gmail_message_id)
);
CREATE INDEX idx_email_events_app ON public.email_events(application_id, received_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_events TO authenticated;
GRANT ALL ON public.email_events TO service_role;
ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own email events" ON public.email_events FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- gmail_sync (one row per user)
CREATE TABLE public.gmail_sync (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  gmail_address TEXT,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  last_history_id TEXT,
  last_synced_at TIMESTAMPTZ,
  scan_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE, DELETE ON public.gmail_sync TO authenticated;
GRANT ALL ON public.gmail_sync TO service_role;
ALTER TABLE public.gmail_sync ENABLE ROW LEVEL SECURITY;
-- Users may READ their own row (to see if connected) and disable/delete it.
-- INSERT/UPDATE of tokens is done server-side via service role only.
CREATE POLICY "Users read own gmail sync" ON public.gmail_sync FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Users update own gmail sync flags" ON public.gmail_sync FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own gmail sync" ON public.gmail_sync FOR DELETE
  USING (auth.uid() = user_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER trg_applications_touch BEFORE UPDATE ON public.applications
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_gmail_sync_touch BEFORE UPDATE ON public.gmail_sync
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
