import "server-only";

const clerkConfigured =
  !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
  !!process.env.CLERK_SECRET_KEY;

/**
 * Resolve the current actor for API routes / server components.
 * When Clerk is configured, enforce auth and return a readable identity.
 * When it isn't (local/demo), return a stub so the app remains usable.
 */
export async function currentActor(): Promise<{ id: string; label: string }> {
  if (!clerkConfigured) {
    return { id: "demo-user", label: "Ops (demo)" };
  }
  const { auth, currentUser } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  const user = await currentUser();
  const label =
    user?.fullName ||
    user?.primaryEmailAddress?.emailAddress ||
    userId;
  return { id: userId, label };
}

/** Guard for API routes: throws if not signed in (no-op in demo mode). */
export async function requireAuth(): Promise<string> {
  const actor = await currentActor();
  return actor.id;
}

export { clerkConfigured };
