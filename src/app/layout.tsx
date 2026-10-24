import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orit | Research Studio",
  description: "Research, simulate, and evaluate a product idea in one workspace.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
