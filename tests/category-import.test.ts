import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { getDemoStore } from "@/lib/demo/store";
import { parseCategorySheet } from "@/lib/clients/category-import";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

const HEADERS = ["Category", "Landing page", "Gross Margin %", "AOV ($)", "Priority"];

function sheet(aoa: unknown[][], fmt: "xlsx" | "csv" = "xlsx"): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1");
  const out = XLSX.write(wb, { type: "array", bookType: fmt }) as ArrayBuffer | Uint8Array;
  return out instanceof Uint8Array ? (out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer) : out;
}

const BAR = ["Bar Stools", "https://shop.example/collections/bar-stools", "35%", "189.00", 2];

describe("parseCategorySheet", () => {
  it("maps headers, percent margin, AOV dollars to cents", () => {
    const { rows, errors } = parseCategorySheet(sheet([HEADERS, BAR]), "cats.xlsx");
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        name: "Bar Stools",
        landing_page_url: "https://shop.example/collections/bar-stools",
        gross_margin_pct: 35,
        average_order_value_cents: 18900,
        priority: 2,
      },
    ]);
  });

  it("treats a margin of 0.35 as 35 and 35 as 35", () => {
    const { rows } = parseCategorySheet(
      sheet([HEADERS, ["A", "", 0.35, 10, 1], ["B", "", 35, 10, 1]]),
      "c.xlsx",
    );
    expect(rows.map((r) => r.gross_margin_pct)).toEqual([35, 35]);
  });

  it("skips blank rows and keeps the first duplicate with an error", () => {
    const { rows, errors } = parseCategorySheet(
      sheet([HEADERS, BAR, [], ["bar stools ", "", 10, 5, 1]]),
      "c.xlsx",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].gross_margin_pct).toBe(35);
    expect(errors.some((e) => e.includes("Bar Stools") || e.includes("bar stools"))).toBe(true);
    expect(errors.some((e) => e.includes("Bar Stools"))).toBe(true);
  });

  it("errors naming accepted headers when the name column is missing", () => {
    const { rows, errors } = parseCategorySheet(sheet([["Foo", "Bar"], ["x", "y"]]), "c.xlsx");
    expect(rows).toEqual([]);
    expect(errors[0]).toMatch(/category/i);
  });

  it("parses CSV identically", () => {
    const x = parseCategorySheet(sheet([HEADERS, BAR]), "c.xlsx");
    const c = parseCategorySheet(sheet([HEADERS, BAR], "csv"), "c.csv");
    expect(c).toEqual(x);
  });

  it("truncates beyond 1000 rows with an error", () => {
    const data = [HEADERS, ...Array.from({ length: 1005 }, (_, i) => [`Cat ${i}`, "", 10, 5, 1])];
    const { rows, errors } = parseCategorySheet(sheet(data), "c.xlsx");
    expect(rows).toHaveLength(1000);
    expect(errors.some((e) => /1,?000/.test(e))).toBe(true);
  });
});

const CLIENT = "client_modern_dental";
const ctx = { params: Promise.resolve({ id: CLIENT }) };
const as = (role: "admin" | "operator") => {
  const p = getDemoStore().profiles.find((x) => x.role === role)!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
};
async function post(aoa: unknown[][], mode?: string, name = "c.xlsx") {
  const { POST } = await import("@/app/api/clients/[id]/services/import/route");
  const form = new FormData();
  form.set("file", new File([sheet(aoa)], name));
  if (mode) form.set("mode", mode);
  const res = await POST(new Request("http://app.test/x", { method: "POST", body: form }), ctx);
  return { res, body: (await res.json()) as { data: { created: number; updated: number; errors: string[] } } };
}
const mine = () => getDemoStore().clientServices.filter((s) => s.client_id === CLIENT);

describe("POST services/import", () => {
  it("merge creates new rows and updates existing by case-insensitive name", async () => {
    as("operator");
    const store = getDemoStore();
    const existing = mine()[0];
    const before = mine().length;
    const { res, body } = await post([
      HEADERS,
      ["  " + existing.name.toUpperCase() + " ", "", 50, 20, 3],
      ["Import Brand New", "", 25, 10, 1],
    ]);
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ created: 1, updated: 1 });
    expect(mine().length).toBe(before + 1);
    const upd = store.clientServices.find((s) => s.id === existing.id)!;
    expect(upd).toMatchObject({ gross_margin_pct: 50, average_order_value_cents: 2000, priority: 3, source: "import" });
    expect(store.clientServices.find((s) => s.name === "Import Brand New")?.source).toBe("import");
  });

  it("replace deactivates rows not in the file and never deletes", async () => {
    as("operator");
    const before = mine().length;
    const { body } = await post([HEADERS, ["Only Keeper", "", 10, 5, 1]], "replace");
    expect(body.data.created).toBe(1);
    expect(mine().length).toBe(before + 1);
    const active = mine().filter((s) => s.is_active);
    expect(active.map((s) => s.name)).toEqual(["Only Keeper"]);
  });

  it("400s without a file and 403s without client access", async () => {
    as("operator");
    const { POST } = await import("@/app/api/clients/[id]/services/import/route");
    const res = await POST(new Request("http://app.test/x", { method: "POST", body: new FormData() }), ctx);
    expect(res.status).toBe(400);
    const store = getDemoStore();
    const p = store.profiles.find((x) => x.role === "operator")!;
    store.userClientAccess = store.userClientAccess.filter((a) => !(a.user_id === p.id && a.client_id === CLIENT));
    expect((await post([HEADERS, BAR])).res.status).toBe(403);
  });
});
