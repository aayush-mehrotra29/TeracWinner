import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function authRedirect(url: URL) {
  return NextResponse.redirect(url, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const requestedNext = url.searchParams.get("next") ?? "/";
  const destination = new URL(requestedNext, url.origin);
  const next = requestedNext.startsWith("/") && destination.origin === url.origin
    ? destination
    : new URL("/", url.origin);

  if (!code) {
    return authRedirect(new URL("/?error=missing-code", url.origin));
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
  } catch {
    return authRedirect(new URL("/?error=callback-failed", url.origin));
  }

  return authRedirect(next);
}
