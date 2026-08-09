import { NextResponse } from "next/server";

import { auth } from "@/auth";

// Runs before the /api/* rewrite, so this gates both pages and every proxied
// FastAPI call. /login, /api/auth/* and static assets are excluded below.
export default auth((req) => {
  if (req.auth?.user) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api")) {
    return NextResponse.json({ detail: "Not authenticated" }, { status: 401 });
  }

  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto") || "https";
  const baseUrl = forwardedHost ? `${forwardedProto}://${forwardedHost}` : req.nextUrl.origin;

  const login = new URL("/login", baseUrl);
  if (pathname !== "/") login.searchParams.set("from", pathname);
  return NextResponse.redirect(login);
});

export const config = {
  matcher: [
    "/((?!api/auth|login|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)",
  ],
};
