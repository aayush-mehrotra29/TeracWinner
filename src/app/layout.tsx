import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TeracWinner | Sign in",
  description: "Sign in to TeracWinner.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
