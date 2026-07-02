import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  getDashboardData,
  syncNow,
  upsertApplication,
  deleteApplication,
  disconnectGmail,
  getSettings,
  saveSettings,
} from "@/lib/job-tracker.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Briefcase,
  LogOut,
  Mail,
  Plus,
  RefreshCw,
  Trash2,
  Pencil,
} from "lucide-react";
import {
  BarChart,
  Bar,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Status = "applied" | "interview" | "offer" | "rejected" | "other";

type Application = {
  id: string;
  company: string;
  role: string;
  applied_at: string;
  status: Status;
  last_status_at: string;
  notes: string | null;
};

const STATUS_META: Record<Status, { label: string; className: string }> = {
  applied: { label: "Applied", className: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30" },
  interview: { label: "Interview", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30" },
  offer: { label: "Offer", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30" },
  rejected: { label: "Rejected", className: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30" },
  other: { label: "Other", className: "bg-muted text-muted-foreground border" },
};

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  timeZone: "UTC",
});

const DATE_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

function formatDate(value: string) {
  return DATE_FORMAT.format(new Date(value));
}

function formatDateTime(value: string) {
  return DATE_TIME_FORMAT.format(new Date(value));
}

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [{ title: "Dashboard · JobTrail" }],
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fetchData = useServerFn(getDashboardData);
  const fetchSync = useServerFn(syncNow);
  const fetchUpsert = useServerFn(upsertApplication);
  const fetchDelete = useServerFn(deleteApplication);
  const fetchDisconnect = useServerFn(disconnectGmail);

  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  // Surface gmail connect outcome from query string
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get("gmail");
    if (g === "connected") {
      toast.success("Gmail connected. Running first scan…");
      params.delete("gmail");
      window.history.replaceState({}, "", window.location.pathname);
    } else if (g === "error") {
      toast.error(`Gmail connection failed: ${params.get("reason") ?? "unknown"}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => fetchData(),
  });

  const syncMut = useMutation({
    mutationFn: () => fetchSync(),
    onSuccess: (r) => {
      toast.success(`Scan complete: ${r.created} new, ${r.updated} updated`);
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => fetchDelete({ data: { id } }),
    onSuccess: () => {
      toast.success("Application deleted");
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const disconnectMut = useMutation({
    mutationFn: () => fetchDisconnect(),
    onSuccess: () => {
      toast.success("Gmail disconnected");
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  async function handleSignOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  const apps = (data?.applications ?? []) as Application[];
  const gmail = data?.gmail as { gmail_address: string | null; last_synced_at: string | null; scan_enabled: boolean } | null;

  const stats = useMemo(() => {
    const by: Record<Status, number> = {
      applied: 0, interview: 0, offer: 0, rejected: 0, other: 0,
    };
    for (const a of apps) by[a.status] += 1;
    return { total: apps.length, by };
  }, [apps]);

  const chartData = useMemo(() => {
    return (["applied", "interview", "offer", "rejected"] as Status[]).map((s) => ({
      status: STATUS_META[s].label,
      count: stats.by[s],
    }));
  }, [stats]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Briefcase className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">JobTrail</h1>
              <p className="text-xs text-muted-foreground">Your job applications, tracked from Gmail.</p>
            </div>
          </div>
          <Button variant="ghost" onClick={handleSignOut}>
            <LogOut className="mr-2 h-4 w-4" /> Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        {/* Gmail connection bar */}
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <Mail className="h-5 w-5 text-muted-foreground" />
              {gmail ? (
                <div>
                  <div className="font-medium">{gmail.gmail_address}</div>
                  <div className="text-xs text-muted-foreground">
                    Last scan: {gmail.last_synced_at ? formatDateTime(gmail.last_synced_at) : "never"}
                    {!gmail.scan_enabled && " · scheduled scans paused"}
                  </div>
                </div>
              ) : (
                <div>
                  <div className="font-medium">Gmail not connected</div>
                  <div className="text-xs text-muted-foreground">Connect to start auto-tracking job emails.</div>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              {gmail ? (
                <>
                  <Button onClick={() => syncMut.mutate()} disabled={syncMut.isPending}>
                    <RefreshCw className={`mr-2 h-4 w-4 ${syncMut.isPending ? "animate-spin" : ""}`} /> Sync now
                  </Button>
                  <Button variant="outline" onClick={() => disconnectMut.mutate()}>
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button
                  onClick={() => {
                    if (!userId) return;
                    window.location.href = `/api/auth/gmail/start?userId=${userId}`;
                  }}
                  disabled={!userId}
                >
                  <Mail className="mr-2 h-4 w-4" /> Connect Gmail
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Tabs defaultValue="apps" className="space-y-6">
          <TabsList>
            <TabsTrigger value="apps">Applications</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="apps" className="space-y-6">
            {/* Stats */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <StatCard label="Total" value={stats.total} />
              <StatCard label="Applied" value={stats.by.applied} />
              <StatCard label="Interview" value={stats.by.interview} />
              <StatCard label="Offer" value={stats.by.offer} accent="text-emerald-500" />
              <StatCard label="Rejected" value={stats.by.rejected} accent="text-rose-500" />
            </div>

            {/* Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Status breakdown</CardTitle>
                <CardDescription>Where your applications are right now.</CardDescription>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="status" stroke="var(--muted-foreground)" />
                    <YAxis allowDecimals={false} stroke="var(--muted-foreground)" />
                    <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }} />
                    <Bar dataKey="count" fill="var(--primary)" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Applications</CardTitle>
                  <CardDescription>Auto-detected from your inbox. Edit anything the AI got wrong.</CardDescription>
                </div>
                <AppDialog
                  onSave={async (form) => {
                    await fetchUpsert({ data: form });
                    qc.invalidateQueries({ queryKey: ["dashboard"] });
                  }}
                  trigger={<Button><Plus className="mr-2 h-4 w-4" /> Add</Button>}
                />
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="py-10 text-center text-muted-foreground">Loading…</div>
                ) : apps.length === 0 ? (
                  <div className="py-10 text-center text-muted-foreground">
                    No applications yet. Connect Gmail and hit "Sync now", or add one manually.
                  </div>
                ) : (
                  <ApplicationsTable
                    apps={apps}
                    onEditSave={async (id, form) => {
                      await fetchUpsert({ data: { ...form, id } });
                      qc.invalidateQueries({ queryKey: ["dashboard"] });
                    }}
                    onDelete={(id) => deleteMut.mutate(id)}
                  />
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings">
            <SettingsPanel />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function ApplicationsTable({
  apps,
  onEditSave,
  onDelete,
}: {
  apps: Application[];
  onEditSave: (id: string, form: FormShape) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [applied, setApplied] = useState("");
  const [status, setStatus] = useState<Status | "all">("all");
  const [lastUpdate, setLastUpdate] = useState("");

  const filtered = useMemo(() => {
    const c = company.trim().toLowerCase();
    const r = role.trim().toLowerCase();
    return apps.filter((a) => {
      if (c && !a.company.toLowerCase().includes(c)) return false;
      if (r && !a.role.toLowerCase().includes(r)) return false;
      if (status !== "all" && a.status !== status) return false;
      if (applied && !a.applied_at.startsWith(applied)) return false;
      if (lastUpdate && !a.last_status_at.startsWith(lastUpdate)) return false;
      return true;
    });
  }, [apps, company, role, applied, status, lastUpdate]);

  const clearAll = () => {
    setCompany(""); setRole(""); setApplied(""); setStatus("all"); setLastUpdate("");
  };
  const hasFilters = !!(company || role || applied || lastUpdate) || status !== "all";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Showing {filtered.length} of {apps.length}
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearAll}>Clear filters</Button>
        )}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Company</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Applied</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last update</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
          <TableRow>
            <TableHead>
              <Input placeholder="Filter…" value={company} onChange={(e) => setCompany(e.target.value)} className="h-8" />
            </TableHead>
            <TableHead>
              <Input placeholder="Filter…" value={role} onChange={(e) => setRole(e.target.value)} className="h-8" />
            </TableHead>
            <TableHead>
              <Input type="date" value={applied} onChange={(e) => setApplied(e.target.value)} className="h-8" />
            </TableHead>
            <TableHead>
              <Select value={status} onValueChange={(v) => setStatus(v as Status | "all")}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {(["applied", "interview", "offer", "rejected", "other"] as Status[]).map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </TableHead>
            <TableHead>
              <Input type="date" value={lastUpdate} onChange={(e) => setLastUpdate(e.target.value)} className="h-8" />
            </TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                No applications match your filters.
              </TableCell>
            </TableRow>
          ) : (
            filtered.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">{a.company}</TableCell>
                <TableCell>{a.role}</TableCell>
                <TableCell>{formatDate(a.applied_at)}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={STATUS_META[a.status].className}>
                    {STATUS_META[a.status].label}
                  </Badge>
                </TableCell>
                <TableCell>{formatDate(a.last_status_at)}</TableCell>
                <TableCell className="text-right">
                  <AppDialog
                    initial={a}
                    onSave={(form) => onEditSave(a.id, form)}
                    trigger={
                      <Button variant="ghost" size="icon">
                        <Pencil className="h-4 w-4" />
                      </Button>
                    }
                  />
                  <Button variant="ghost" size="icon" onClick={() => onDelete(a.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function SettingsPanel() {
  const qc = useQueryClient();
  const fetchGet = useServerFn(getSettings);
  const fetchSave = useServerFn(saveSettings);
  const { data, isLoading } = useQuery({
    queryKey: ["user-settings"],
    queryFn: () => fetchGet(),
  });
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (data && !initialized) {
      setApiKey(data.gemini_api_key ?? "");
      setModel(data.gemini_model ?? "");
      setInitialized(true);
    }
  }, [data, initialized]);

  const saveMut = useMutation({
    mutationFn: () => fetchSave({ data: { gemini_api_key: apiKey, gemini_model: model } }),
    onSuccess: () => {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["user-settings"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI Settings</CardTitle>
        <CardDescription>
          Override the Gemini API key and model used to classify your emails. Leave blank to use the server defaults.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <div className="space-y-2">
              <Label>Gemini API key</Label>
              <Input
                type="password"
                autoComplete="off"
                placeholder="AIza…"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Stored per user. Get one at aistudio.google.com/apikey.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Gemini model</Label>
              <Input
                placeholder="gemini-2.5-flash"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Any Gemini model id, e.g. <code>gemini-2.5-flash</code>, <code>gemini-2.5-pro</code>, <code>gemini-2.0-flash</code>.
              </p>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
                {saveMut.isPending ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <Card>
      <CardContent className="py-5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`mt-1 text-3xl font-semibold ${accent ?? ""}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

type FormShape = {
  company: string;
  role: string;
  applied_at: string;
  status: Status;
  notes: string | null;
};

function AppDialog({
  initial,
  onSave,
  trigger,
}: {
  initial?: Application;
  onSave: (form: FormShape) => Promise<void>;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormShape>(() => ({
    company: initial?.company ?? "",
    role: initial?.role ?? "",
    applied_at: initial?.applied_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    status: initial?.status ?? "applied",
    notes: initial?.notes ?? "",
  }));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await onSave({
        ...form,
        applied_at: new Date(form.applied_at).toISOString(),
      });
      setOpen(false);
      toast.success("Saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit application" : "Add application"}</DialogTitle>
          <DialogDescription>Track an application manually.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Company</Label>
            <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Applied date</Label>
              <Input type="date" value={form.applied_at.slice(0, 10)} onChange={(e) => setForm({ ...form, applied_at: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as Status })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(["applied", "interview", "offer", "rejected", "other"] as Status[]).map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea rows={3} value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy || !form.company || !form.role}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
