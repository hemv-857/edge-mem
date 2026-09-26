import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "EDGE.MEM — Qdrant Edge Intelligence Platform",
  description:
    "Offline-first AI edge memory & intelligence platform. Local semantic memory, hybrid retrieval, policy-driven edge↔cloud sync, conflict resolution — powered by Qdrant Edge.",
  keywords: ["Qdrant Edge", "edge AI", "vector search", "offline", "hybrid retrieval", "edge intelligence"],
  authors: [{ name: "Edge Intelligence" }],
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
