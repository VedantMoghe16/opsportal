import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  googleAuthConfigured,
  exchangeCodeForUser,
  emailAllowed,
  publicOrigin,
} from "@/lib/auth/google";
import { signSession, SESSION_COOKIE, SESSION_MAX_AGE_S } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Google redirects here with ?code&state. Verify, mint a session, land on home. */
export async function GET(req: Request) {
  // Redirect to the PUBLIC origin (via forwarded headers / NEXT_PUBLIC_APP_URL),
  // not req.url — behind the proxy req.url is the internal localhost:3003 bind.
  const origin = publicOrigin(req);
  const home = (path: string) => new URL(path, origin);
  if (!googleAuthConfigured()) return NextResponse.redirect(home("/"));

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const jar = await cookies();
  const savedState = jar.get("g_oauth_state")?.value;

  if (!code || !state || !savedState || state !== savedState) {
    return NextResponse.redirect(home("/sign-in?error=state"));
  }

  let user;
  try {
    user = await exchangeCodeForUser(code);
  } catch {
    return NextResponse.redirect(home("/sign-in?error=exchange"));
  }

  if (!user.emailVerified || !emailAllowed(user.email)) {
    return NextResponse.redirect(home("/sign-in?error=forbidden"));
  }

  const token = signSession({
    sub: user.sub,
    email: user.email,
    name: user.name,
    picture: user.picture,
  });
  const res = NextResponse.redirect(home("/"));
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });
  res.cookies.delete("g_oauth_state");
  return res;
}
