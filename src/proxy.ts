import { NextResponse, type NextRequest } from "next/server";
import {
  createWorkspaceToken, validWorkspaceToken, WORKSPACE_COOKIE, workspaceCookieOptions, workspaceSecret,
} from "@/lib/api/workspace-identity";

export function proxy(request: NextRequest) {
  // Participant forms use their own opaque study token, not the owner's local
  // workspace cookie.
  if (request.nextUrl.pathname.startsWith("/study/") ||
      request.nextUrl.pathname.startsWith("/api/study/")) {
    return NextResponse.next({ request });
  }

  const secret = workspaceSecret();
  if (!secret) return NextResponse.next({ request });
  let token = request.cookies.get(WORKSPACE_COOKIE)?.value;
  const fresh = !validWorkspaceToken(token, secret);
  if (fresh) {
    token = createWorkspaceToken(secret);
    request.cookies.set(WORKSPACE_COOKIE, token);
  }
  const response = NextResponse.next({ request });
  if (fresh) response.cookies.set(WORKSPACE_COOKIE, token!,
    workspaceCookieOptions(request.nextUrl.protocol === "https:"));
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
