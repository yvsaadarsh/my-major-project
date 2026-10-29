import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

/**
 * Fonts are loaded from the locally bundled `geist` package rather than
 * `next/font/google`.
 *
 * `next/font/google` fetches the font files from fonts.googleapis.com at build
 * time, which makes `next build` fail in any environment without egress to
 * that host — it is a build-time network dependency on a third party for
 * assets that do not change. The `geist` package is Vercel's own distribution
 * of the same two typefaces, ships the .woff2 files inside the package, and
 * wraps them with `next/font/local`, so the build is self-contained.
 *
 * The design is unchanged: these are the same families, and the package's
 * default CSS variables are the same `--font-geist-sans` and
 * `--font-geist-mono` names the markup below already referenced.
 */
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

const geistSans = GeistSans;
const geistMono = GeistMono;

export const metadata: Metadata = {
  title: "ProjectOS",
  description: "Multi-tenant SaaS project management platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
