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
  title: "Kluely — interview answers in Klingon",
  description:
    "Speak an interview question, get a strong answer rendered in Klingon.",
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
