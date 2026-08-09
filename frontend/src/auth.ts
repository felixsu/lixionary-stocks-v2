import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// Comma-separated allowlist. Empty means any Google account may sign in —
// set this in production, the app is otherwise open to the whole internet's
// worth of Google users.
const allowedEmails = (process.env.AUTH_ALLOWED_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  // The app is served behind Tailscale on a non-public origin; Auth.js must
  // trust the Host header instead of requiring AUTH_URL.
  trustHost: true,
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    signIn({ profile }) {
      if (allowedEmails.length === 0) return true;
      const email = profile?.email?.toLowerCase();
      return !!email && allowedEmails.includes(email);
    },
  },
});
