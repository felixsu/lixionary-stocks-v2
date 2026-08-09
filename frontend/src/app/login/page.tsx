import { redirect } from "next/navigation";

import { auth, signIn } from "@/auth";

// Only same-app paths may be used as a post-login destination.
function safePath(from: string | undefined): string {
  return from && from.startsWith("/") && !from.startsWith("//") ? from : "/";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const { from, error } = await searchParams;

  const session = await auth();
  if (session?.user) redirect(safePath(from));

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--color-canvas)",
        fontFamily: "var(--font-sans)",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 380,
          background: "var(--color-surface-card)",
          border: "1px solid var(--color-hairline)",
          borderRadius: 16,
          padding: "40px 32px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          textAlign: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ fontFamily: "var(--font-serif)", fontSize: 28, color: "var(--color-ink)" }}>
            Lixionary
          </span>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 9999,
              background: "var(--color-primary)",
              display: "inline-block",
            }}
          />
        </div>

        <p style={{ margin: 0, fontSize: 14, color: "var(--color-muted)", lineHeight: 1.5 }}>
          IHSG stock analytics. Sign in to continue.
        </p>

        {error && (
          <p
            role="alert"
            style={{
              margin: "8px 0 0",
              fontSize: 13,
              color: "var(--color-negative, #b3261e)",
              lineHeight: 1.5,
            }}
          >
            {error === "AccessDenied"
              ? "This Google account is not allowed to access this app."
              : "Sign-in failed. Please try again."}
          </p>
        )}

        <form
          style={{ width: "100%", marginTop: 20 }}
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: safePath(from) });
          }}
        >
          <button
            type="submit"
            style={{
              width: "100%",
              height: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              borderRadius: 10,
              border: "1px solid var(--color-hairline)",
              background: "var(--color-ink)",
              color: "var(--color-canvas)",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.17 3.57-8.81Z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.96-1.07 7.93-2.91l-3.87-3c-1.07.72-2.44 1.14-4.06 1.14-3.12 0-5.77-2.11-6.71-4.95H1.29v3.09A12 12 0 0 0 12 24Z"
              />
              <path
                fill="#FBBC05"
                d="M5.29 14.28a7.22 7.22 0 0 1 0-4.56V6.63H1.29a12 12 0 0 0 0 10.74l4-3.09Z"
              />
              <path
                fill="#EA4335"
                d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44A11.98 11.98 0 0 0 1.29 6.63l4 3.09C6.23 6.88 8.88 4.77 12 4.77Z"
              />
            </svg>
            Continue with Google
          </button>
        </form>
      </div>
    </main>
  );
}
