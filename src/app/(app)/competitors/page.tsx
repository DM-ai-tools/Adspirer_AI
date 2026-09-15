import { redirect } from "next/navigation";

/** Competitor Intelligence portal removed — keep route as a soft redirect. */
export default function CompetitorsRedirectPage() {
  redirect("/monitoring");
}
