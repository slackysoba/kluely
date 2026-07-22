import type { Metadata } from "next";
import { Space_Grotesk, Space_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

// Trial font swap (Geist → Space Grotesk/Mono). The CSS variable names are
// kept so the rest of the app is untouched; revert this file to undo.
const uiSans = Space_Grotesk({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const uiMono = Space_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

// Klingon pIqaD (CSUR PUA U+F8D0–U+F8FF). See public/fonts/LICENSE.
const piqad = localFont({
  src: "../public/fonts/pIqaD-qolqoS.ttf",
  variable: "--font-piqad",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
  ),
  title: "Kluely — interview coaching for Klingons",
  description:
    "Speak the interviewer's question aloud and answer with honor.",
  openGraph: {
    title: "Kluely",
    description: "Interview coaching for Klingons.",
    siteName: "Kluely",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Kluely",
    description: "Interview coaching for Klingons.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${uiSans.variable} ${uiMono.variable} ${piqad.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
