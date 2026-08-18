"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Profile, UserRole } from "@/types";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserCog } from "lucide-react";

export default function AdminTeamPage() {
  const { user, clients } = useApp();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<UserRole>("operator");
  const [busy, setBusy] = useState(false);
  const [assignUserId, setAssignUserId] = useState("");
  const [assignClientId, setAssignClientId] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ users: Profile[] }>("/api/admin/team");
      setUsers(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load team");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const data = await apiFetch<{
        message?: string;
        delivery?: string;
      }>("/api/admin/team", {
        method: "POST",
        body: JSON.stringify({
          email,
          fullName: fullName || undefined,
          role,
        }),
      });
      toast.success(data.message ?? "Team member added");
      setEmail("");
      setFullName("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invite failed");
    } finally {
      setBusy(false);
    }
  }

  async function assignClient() {
    if (!assignUserId || !assignClientId) return;
    try {
      await apiFetch(`/api/admin/team/${assignUserId}/clients`, {
        method: "PUT",
        body: JSON.stringify({ clientIds: [assignClientId] }),
      });
      toast.success("Client access updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Assign failed");
    }
  }

  if (user?.profile.role !== "admin") {
    return (
      <EmptyState
        icon={UserCog}
        title="Admin only"
        description="Team management requires an admin role."
      />
    );
  }

  if (loading) return <LoadingState skeleton />;
  if (error) return <ErrorState description={error} onRetry={() => void load()} />;

  return (
    <div>
      <PageHeader
        title="Team"
        description="Invite operators and grant client access."
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">
                          {u.full_name ?? u.email}
                        </p>
                        <p className="font-mono text-[11px] text-muted">
                          {u.email}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">
                        {u.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.is_active ? "success" : "muted"}>
                        {u.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted">
                      {formatRelative(u.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Invite member</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={invite}>
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="fullName">Full name</Label>
                  <Input
                    id="fullName"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Role</Label>
                  <Select
                    value={role}
                    onValueChange={(v) => setRole(v as UserRole)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="operator">Operator</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? "Inviting…" : "Invite"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Grant client access</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Select value={assignUserId} onValueChange={setAssignUserId}>
                <SelectTrigger>
                  <SelectValue placeholder="User" />
                </SelectTrigger>
                <SelectContent>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.full_name ?? u.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={assignClientId} onValueChange={setAssignClientId}>
                <SelectTrigger>
                  <SelectValue placeholder="Client" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                className="w-full"
                variant="secondary"
                onClick={() => void assignClient()}
              >
                Grant access
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
