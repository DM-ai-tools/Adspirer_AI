import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DEMO_USER_COOKIE } from "@/lib/security/auth";

export default async function HomePage() {
  const cookieStore = await cookies();
  const demoUser = cookieStore.get(DEMO_USER_COOKIE)?.value;
  if (demoUser) {
    redirect("/dashboard");
  }
  redirect("/login");
}
