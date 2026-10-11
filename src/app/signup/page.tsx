import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { SiteNav, SiteFooter } from "@/components/site";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Create an account — LeadGenius",
};

// Reads the session cookie, so it can never be prerendered.
export const dynamic = "force-dynamic";

export default async function SignupPage() {
  if (await getSession()) redirect("/dashboard");

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <SiteNav />
      <main className="mx-auto flex max-w-sm flex-col justify-center px-6 py-16">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Abetworks</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-emerald-600">LeadGenius</h1>
        <p className="mt-2 text-sm text-gray-600">Outreach that earns replies, not spam complaints.</p>
        <div className="mt-8">
          <AuthForm mode="signup" accent="text-emerald-600" />
        </div>
        <ul className="mt-8 space-y-1.5 text-[13px] text-gray-600">
          <li>· Your own workspace, separate from everyone else's</li>
          <li>· API keys for the parts you automate</li>
          <li>· No card required to start</li>
        </ul>
      </main>
      <SiteFooter />
    </div>
  );
}
