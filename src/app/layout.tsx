import type { Metadata, Viewport } from "next";
import { SessionProvider } from "next-auth/react";
import { ToastProvider } from "@/components/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "Recall — spaced repetition flashcards",
  description:
    "Study flashcards with spaced repetition, AI-varied prompts, streaks and accuracy tracking. Syncs across every device.",
  applicationName: "Recall",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Recall" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The study screen is a focused, app-like surface; zooming breaks its layout
  // but pinch-zoom stays available since maximumScale is left unset.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7fb" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0e13" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <SessionProvider>
          <ToastProvider>{children}</ToastProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
