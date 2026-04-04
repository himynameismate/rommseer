import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl;
    const token = req.nextauth.token;

    // Admin-only API routes
    const adminRoutes = [
      "/api/settings",
      "/api/users",
      "/api/downloads",
      "/api/invites",
      "/api/activity",
      "/api/prowlarr",
    ];

    if (
      adminRoutes.some((r) => pathname.startsWith(r)) &&
      token?.role !== "ADMIN"
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.next();
  },
  {
    secret: process.env.NEXTAUTH_SECRET,
    callbacks: {
      authorized: ({ token, req }) => {
        const { pathname } = req.nextUrl;

        // Public paths that don't require authentication
        const publicPaths = [
          "/login",
          "/register",
          "/api/auth",
          "/api/settings/public",
        ];

        if (publicPaths.some((p) => pathname.startsWith(p))) {
          return true;
        }

        // All other routes require a valid token
        return !!token;
      },
    },
  }
);

export const config = {
  matcher: [
    // Match all routes except static assets and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
