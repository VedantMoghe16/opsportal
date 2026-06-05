import { redirect } from "next/navigation";
import { Logo } from "@/components/layout/logo";

const clerkConfigured = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default async function SignUpPage() {
  if (!clerkConfigured) redirect("/");
  const { SignUp } = await import("@clerk/nextjs");
  return (
    <div className="app-wash flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <Logo variant="dark" />
      <SignUp appearance={{ variables: { colorPrimary: "#9acd32" } }} />
    </div>
  );
}
