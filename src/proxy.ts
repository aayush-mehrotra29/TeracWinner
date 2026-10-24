import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  // Participant forms use their own opaque study token.
  if (request.nextUrl.pathname.startsWith("/study/") ||
      request.nextUrl.pathname.startsWith("/api/study/")) {
    return NextResponse.next({ request });
  }

  const response = NextResponse.next({ request });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
