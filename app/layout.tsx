import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "flow",
  description: "A minimal flow chart diagram maker",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
