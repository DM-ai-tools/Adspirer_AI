"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, MoreHorizontal, UserCog } from "lucide-react";
import type { UserRole } from "@/types";
import type { LinkResult, MemberStatus, TeamMember } from "@/lib/team/members";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const STATUS: Record<MemberStatus, { label: string; variant: "success" | "warning" | "muted" }> = {
  active: { label: "Active", variant: "success" },
  invited: { label: "Invited", variant: "warning" },
  deactivated: { label: "Deactivated", variant: "muted" },
};

function ClientChecklist({
  clients,
  selected,
  onChange,
}: {
  clients: Array<{ id: string; name: string }>;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  if (!clients.length) return <p className="text-xs text-muted">No clients yet.</p>;
  return (
    <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border border-border-subtle p-2">
      {clients.map((c) => (
        <label key={c.id} className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={selected.includes(c.id)}
            onCheckedChange={(on) => onChange(on ? [...selected, c.id] : selected.filter((id) => id !== c.id))}
          />
          {c.name}
        </label>
      ))}
    </div>
  );
}

export default function AdminTeamPage() {
  const { user, clients } = useApp();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<UserRole>("operator");
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  /** A link to hand over when email isn't set up. */
  const [shareLink, setShareLink] = useState<{ email: string; link: string; kind: string; reason?: string } | null>(null);
  const [details, setDetails] = useState<TeamMember | null>(null);
  const [detailClients, setDetailClients] = useState<string[]>([]);

  async function load() {
    try {
      const data = await apiFetch<{ members: TeamMember[] }>("/api/admin/team");
      setMembers(data.members);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load team");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ members: TeamMember[] }>("/api/admin/team")
      .then((data) => !cancelled && setMembers(data.members))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load team"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  function handOver(result: LinkResult, kind: string, done: string) {
    if (result.emailed) toast.success(done);
    else if (result.link) setShareLink({ email: result.member.email, link: result.link, kind, reason: result.emailError });
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy("invite");
    try {
      const result = await apiFetch<LinkResult>("/api/admin/team", {
        method: "POST",
        body: JSON.stringify({ email, fullName: fullName || undefined, role, clientIds: role === "operator" ? clientIds : [] }),
      });
      handOver(result, "invite", `Invite sent to ${result.member.email}`);
      setEmail("");
      setFullName("");
      setClientIds([]);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invite failed");
    } finally {
      setBusy(null);
    }
  }

  async function act(member: TeamMember, action: "resend" | "reset" | "role" | "active") {
    setBusy(member.id);
    try {
      if (action === "resend" || action === "reset") {
        const result = await apiFetch<LinkResult>(
          `/api/admin/team/${member.id}/${action === "resend" ? "resend-invite" : "password-reset"}`,
          { method: "POST" },
        );
        handOver(result, action === "resend" ? "invite" : "reset", action === "resend" ? `New invite sent to ${member.email}` : `Password reset sent to ${member.email}`);
      } else {
        const body =
          action === "role"
            ? { role: member.role === "admin" ? "operator" : "admin" }
            : { isActive: member.status === "deactivated" };
        await apiFetch(`/api/admin/team/${member.id}`, { method: "PATCH", body: JSON.stringify(body) });
        toast.success("Member updated");
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function saveClients() {
    if (!details) return;
    setBusy(details.id);
    try {
      await apiFetch(`/api/admin/team/${details.id}`, { method: "PATCH", body: JSON.stringify({ clientIds: detailClients }) });
      toast.success("Client access saved");
      setDetails(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  if (user?.profile.role !== "admin") {
    return <EmptyState icon={UserCog} title="Admin only" description="Team management requires an admin role." />;
  }
  if (loading) return <LoadingState skeleton />;
  if (error) return <ErrorState description={error} onRetry={() => void load()} />;

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? id;

  return (
    <div>
      <PageHeader title="Team" description="Invite people by email, choose their role, and control which clients they see." />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left"
                        onClick={() => {
                          setDetails(m);
                          setDetailClients(m.clientIds);
                        }}
                      >
                        <p className="font-medium hover:underline">{m.fullName ?? m.email}</p>
                        <p className="font-mono text-[11px] text-muted">{m.email}</p>
                      </button>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">
                        {m.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS[m.status].variant}>{STATUS[m.status].label}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted">
                      {m.lastSignInAt ? formatRelative(m.lastSignInAt) : m.status === "invited" ? "Not yet" : "—"}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={busy === m.id} aria-label={`Actions for ${m.email}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => {
                              setDetails(m);
                              setDetailClients(m.clientIds);
                            }}
                          >
                            View details
                          </DropdownMenuItem>
                          {m.status === "invited" ? (
                            <DropdownMenuItem onSelect={() => void act(m, "resend")}>Resend invite</DropdownMenuItem>
                          ) : null}
                          {m.status !== "deactivated" ? (
                            <DropdownMenuItem onSelect={() => void act(m, "reset")}>Send password reset</DropdownMenuItem>
                          ) : null}
                          {m.id !== user.id ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onSelect={() => void act(m, "role")}>
                                Make {m.role === "admin" ? "operator" : "admin"}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className={m.status === "deactivated" ? undefined : "text-danger"}
                                onSelect={() => void act(m, "active")}
                              >
                                {m.status === "deactivated" ? "Reactivate" : "Deactivate"}
                              </DropdownMenuItem>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invite member</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={invite}>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fullName">Full name (optional)</Label>
                <Input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Role</Label>
                <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="operator">Operator — works on assigned clients</SelectItem>
                    <SelectItem value="admin">Admin — all clients, team and settings</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {role === "operator" ? (
                <div className="space-y-1.5">
                  <Label>Client access</Label>
                  <ClientChecklist clients={clients} selected={clientIds} onChange={setClientIds} />
                </div>
              ) : null}
              <Button type="submit" className="w-full" disabled={busy === "invite"}>
                {busy === "invite" ? "Sending…" : "Send invite"}
              </Button>
              <p className="text-[11px] text-muted">
                They get an email with a one-time link to set their password and sign in. The link expires in 24 hours.
              </p>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* Link to hand over when email isn't configured */}
      <Dialog open={shareLink != null} onOpenChange={(open) => !open && setShareLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{shareLink?.kind === "reset" ? "Password reset link" : "Invite link"}</DialogTitle>
            <DialogDescription>
              The email couldn&apos;t be sent{shareLink?.reason ? `: ${shareLink.reason}` : ""}. Send this link to{" "}
              {shareLink?.email} yourself. It works once and expires in 24 hours.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={shareLink?.link ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button
              variant="secondary"
              onClick={() => {
                if (!shareLink) return;
                void navigator.clipboard.writeText(shareLink.link).then(() => toast.success("Link copied"));
              }}
            >
              <Copy className="mr-1 h-3.5 w-3.5" /> Copy
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Member details */}
      <Dialog open={details != null} onOpenChange={(open) => !open && setDetails(null)}>
        <DialogContent>
          {details ? (
            <>
              <DialogHeader>
                <DialogTitle>{details.fullName ?? details.email}</DialogTitle>
                <DialogDescription className="font-mono text-xs">{details.email}</DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-sm">
                <dt className="text-muted">Role</dt>
                <dd className="capitalize">{details.role}</dd>
                <dt className="text-muted">Status</dt>
                <dd>
                  <Badge variant={STATUS[details.status].variant}>{STATUS[details.status].label}</Badge>
                </dd>
                <dt className="text-muted">Invited</dt>
                <dd>{details.invitedAt ? new Date(details.invitedAt).toLocaleString() : "—"}</dd>
                <dt className="text-muted">Last sign-in</dt>
                <dd>{details.lastSignInAt ? new Date(details.lastSignInAt).toLocaleString() : "Never"}</dd>
                <dt className="text-muted">Member since</dt>
                <dd>{new Date(details.createdAt).toLocaleDateString()}</dd>
                <dt className="text-muted">Password</dt>
                <dd className="text-muted">Never visible to anyone — use Send password reset.</dd>
              </dl>
              {details.role === "operator" ? (
                <div className="space-y-1.5">
                  <Label>Client access</Label>
                  <ClientChecklist clients={clients} selected={detailClients} onChange={setDetailClients} />
                </div>
              ) : (
                <p className="text-xs text-muted">Admins see every client.</p>
              )}
              <DialogFooter>
                {details.role === "operator" ? (
                  <Button onClick={() => void saveClients()} disabled={busy === details.id}>
                    Save client access
                  </Button>
                ) : null}
              </DialogFooter>
              {details.role === "operator" && details.clientIds.length ? (
                <p className="text-[11px] text-muted">Currently: {details.clientIds.map(clientName).join(", ")}</p>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
