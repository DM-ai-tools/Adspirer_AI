import { pdf } from "@react-pdf/renderer";
import type { AuditReport } from "@/lib/report/schema";
import { AuditReportDoc } from "@/lib/report/pdf/AuditReportDoc";
import { ensureReportFonts } from "@/lib/report/pdf/fonts";

export async function renderAuditReportPdf(
  report: AuditReport,
): Promise<Uint8Array> {
  ensureReportFonts();
  const instance = pdf(<AuditReportDoc r={report} />);
  const blob = await instance.toBlob();
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}
