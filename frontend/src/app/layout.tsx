import type { Metadata } from "next";
import { Cormorant_Garamond, Inter, JetBrains_Mono } from "next/font/google";

import { AppShell } from "@/components/AppShell";

import "@/styles/globals.css";

const serif = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-next-serif",
});

const sans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-next-sans",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-next-mono",
});

export const metadata: Metadata = {
  title: "Lixionary Stock",
  description: "IHSG stock analytics",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
