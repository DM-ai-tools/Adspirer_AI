"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ClientService } from "@/types/database";
import { apiFetch } from "@/lib/api-client";
import {
  categoryPatchFromEdit,
  filterServiceRows,
  importOutcome,
  type CategoryFormField,
} from "@/lib/clients/category-form";
import { CategoryScan } from "@/components/clients/category-scan";
import { CategoryGoogleImport } from "@/components/clients/category-google-import";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function display(s: ClientService, field: CategoryFormField): string {
  switch (field) {
    case "name":
      return s.name;
    case "landing_page_url":
      return s.landing_page_url ?? "";
    case "gross_margin_pct":
      return s.gross_margin_pct != null ? String(s.gross_margin_pct) : "";
    case "average_order_value":
      return s.average_order_value_cents != null ? (s.average_order_value_cents / 100).toFixed(2) : "";
    case "priority":
      return String(s.priority ?? 0);
  }
}

/** One inline-editable cell: saves on blur or Enter; an invalid value shows its error and sends nothing. */
function EditCell({
  service,
  field,
  placeholder,
  onSave,
}: {
  service: ClientService;
  field: CategoryFormField;
  placeholder?: string;
  // Resolves to null on success, or the API error message.
  onSave: (patch: Record<string, unknown>) => Promise<string | null>;
}) {
  const shown = display(service, field);
  // null = not being edited, so the cell follows the saved value.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? shown;

  async function commit() {
    if (draft === null || draft === shown) {
      setDraft(null);
      setError(null);
      return;
    }
    const result = categoryPatchFromEdit(field, value);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    const failure = await onSave(result.patch);
    if (failure) setError(failure);
    else setDraft(null);
  }

  return (
    <div>
      <Input
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className="h-8"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(null);
            setError(null);
          }
        }}
      />
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
    </div>
  );
}

/** Per-category margin and order value the strategy planner reads. */
export function CategoriesPanel({
  clientId,
  categoryWord,
}: {
  clientId: string;
  categoryWord: "category" | "service";
}) {
  const base = `/api/clients/${clientId}/services`;
  const word = categoryWord;
  const plural = word === "category" ? "categories" : "services";
  const [rows, setRows] = useState<ClientService[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ services: ClientService[] }>(`${base}?seed=0`);
      setRows(data.services);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load");
    }
  }, [base]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const shownRows = filterServiceRows(rows ?? [], query);

  async function patch(service: ClientService, body: Record<string, unknown>): Promise<string | null> {
    try {
      const data = await apiFetch<{ service: ClientService }>(`${base}/${service.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setRows((prev) => prev?.map((r) => (r.id === service.id ? data.service : r)) ?? null);
      return null;
    } catch (err) {
      // The cell keeps the typed value and shows this inline; no reload over it.
      return err instanceof Error ? err.message : "Could not save";
    }
  }

  async function remove(service: ClientService) {
    if (!window.confirm(`Delete "${service.name}"?`)) return;
    try {
      await apiFetch<{ ok: true }>(`${base}/${service.id}`, { method: "DELETE" });
      setRows((prev) => prev?.filter((r) => r.id !== service.id) ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete");
    }
  }

  async function importFile(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("mode", mode);
      // Not apiFetch: it forces a JSON content type, which would break the multipart boundary.
      const res = await fetch(`${base}/import`, { method: "POST", body: form, credentials: "same-origin" });
      const outcome = importOutcome(res.ok, await res.json().catch(() => null));
      if (!outcome.ok) throw new Error(outcome.error);
      toast[outcome.errors ? "warning" : "success"](
        `Import done: ${outcome.created} created, ${outcome.updated} updated, ${outcome.errors} errors`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base capitalize">{plural}</CardTitle>
        <p className="text-sm text-muted">
          Margin and average order value let strategies plan per {word}. Click a cell to edit.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start gap-3">
          <select
            aria-label="Import mode"
            className="h-9 rounded-lg border border-border bg-input px-2 text-sm text-foreground shadow-sm"
            value={mode}
            onChange={(e) => setMode(e.target.value as "merge" | "replace")}
          >
            <option value="merge">Merge with existing</option>
            <option value="replace">Replace existing</option>
          </select>
          <Button type="button" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "Importing…" : "Import from Excel/CSV"}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
            }}
          />
          <CategoryScan clientId={clientId} word={word} onAdded={() => void load()} />
          <CategoryGoogleImport clientId={clientId} word={word} onAdded={() => void load()} />
        </div>
        {mode === "replace" ? (
          <p className="text-xs text-muted">
            Replace deactivates {plural} missing from the file. It does not delete them.
          </p>
        ) : null}

        {loadError ? (
          <p className="text-sm text-danger">{loadError}</p>
        ) : rows === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">Add your {plural} so strategies can plan per {word}.</p>
        ) : (
          <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${rows.length} ${plural}, e.g. bar stools`}
              aria-label={`Search ${plural}`}
              className="max-w-xs"
            />
            {query.trim() ? (
              <span className="text-xs text-muted">
                {shownRows.length} of {rows.length} shown
              </span>
            ) : null}
          </div>
          {shownRows.length === 0 ? (
            <p className="text-sm text-muted">No {plural} match “{query.trim()}”.</p>
          ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Landing page</TableHead>
                <TableHead>Margin %</TableHead>
                <TableHead>Order value</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Source</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownRows.map((s) => (
                <TableRow key={s.id} className={s.is_active ? undefined : "opacity-60"}>
                  <TableCell className="min-w-40"><EditCell service={s} field="name" onSave={(p) => patch(s, p)} /></TableCell>
                  <TableCell><EditCell service={s} field="landing_page_url" placeholder="https://" onSave={(p) => patch(s, p)} /></TableCell>
                  <TableCell><EditCell service={s} field="gross_margin_pct" placeholder="e.g. 55" onSave={(p) => patch(s, p)} /></TableCell>
                  <TableCell><EditCell service={s} field="average_order_value" placeholder="e.g. 189.50" onSave={(p) => patch(s, p)} /></TableCell>
                  <TableCell><EditCell service={s} field="priority" onSave={(p) => patch(s, p)} /></TableCell>
                  <TableCell className="text-xs text-muted">{s.is_active ? (s.source ?? "manual") : "inactive"}</TableCell>
                  <TableCell>
                    <Button type="button" size="sm" variant="ghost" onClick={() => void remove(s)}>
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
