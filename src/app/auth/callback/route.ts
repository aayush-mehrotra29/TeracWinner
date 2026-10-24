import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const requestedNext = url.searchParams.get("next") ?? "/";
  const destination = new URL(requestedNext, url.origin);
  const next = requestedNext.startsWith("/") && destination.origin === url.origin
    ? destination
    : new URL("/", url.origin);

  if (!code) {
    return NextResponse.redirect(new URL("/?error=missing-code", url.origin));
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
  } catch {
    return NextResponse.redirect(new URL("/?error=callback-failed", url.origin));
  }

  return NextResponse.redirect(next);
}
