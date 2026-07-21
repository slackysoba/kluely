import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
      className={`${geistSans.variable} ${geistMono.variable} ${piqad.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
