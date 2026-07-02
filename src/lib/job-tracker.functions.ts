import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normalize } from "./normalize";

export const getDashboardData = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [appsRes, syncRes] = await Promise.all([
      supabase
        .from("applications")
        .select("*")
        .eq("user_id", userId)
        .order("last_status_at", { ascending: false }),
      supabase.from("gmail_sync").select("gmail_address,last_synced_at,scan_enabled").eq("user_id", userId).maybeSingle(),
    ]);
    if (appsRes.error) throw appsRes.error;
    return {
      applications: appsRes.data ?? [],
      gmail: syncRes.data ?? null,
    };
  });

const UpsertSchema = z.object({
  id: z.string().uuid().optional(),
  company: z.string().min(1).max(200),
  role: z.string().min(1).max(200),
  applied_at: z.string(),
  status: z.enum(["applied", "interview", "offer", "rejected", "other"]),
  notes: z.string().max(2000).optional().nullable(),
});

export const upsertApplication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => UpsertSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const row = {
      user_id: userId,
      company: data.company,
      company_norm: normalize(data.company),
      role: data.role,
      role_norm: normalize(data.role),
      applied_at: data.applied_at,
      status: data.status,
      last_status_at: new Date().toISOString(),
      notes: data.notes ?? null,
      source: "manual",
    };
    if (data.id) {
      const { error } = await supabase.from("applications").update(row).eq("id", data.id).eq("user_id", userId);
      if (error) throw error;
      return { id: data.id };
    }
    const { data: ins, error } = await supabase
      .from("applications")
      .insert(row)
      .select("id")
      .single();
    if (error) throw error;
    return { id: ins.id as string };
  });

export const deleteApplication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("applications").delete().eq("id", data.id).eq("user_id", userId);
    if (error) throw error;
    return { ok: true };
  });

export const syncNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { syncUserGmail } = await import("./gmail.server");
    return syncUserGmail(context.userId);
  });

export const disconnectGmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase.from("gmail_sync").delete().eq("user_id", context.userId);
    if (error) throw error;
    return { ok: true };
  });

export const toggleScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ enabled: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("gmail_sync")
      .update({ scan_enabled: data.enabled })
      .eq("user_id", context.userId);
    if (error) throw error;
    return { ok: true };
  });

export const getSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_settings")
      .select("gemini_api_key,gemini_model")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw error;
    return {
      gemini_api_key: (data as any)?.gemini_api_key ?? "",
      gemini_model: (data as any)?.gemini_model ?? "",
    };
  });

const SettingsSchema = z.object({
  gemini_api_key: z.string().max(200).optional().nullable(),
  gemini_model: z.string().max(100).optional().nullable(),
});

export const saveSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SettingsSchema.parse(input))
  .handler(async ({ data, context }) => {
    const row = {
      user_id: context.userId,
      gemini_api_key: data.gemini_api_key?.trim() || null,
      gemini_model: data.gemini_model?.trim() || null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await context.supabase
      .from("user_settings")
      .upsert(row, { onConflict: "user_id" });
    if (error) throw error;
    return { ok: true };
  });
