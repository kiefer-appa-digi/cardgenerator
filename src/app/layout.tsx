import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Card Designer — Freedom Trailer Parts",
    template: "%s · Card Designer",
  },
  description:
    "Production packaging-artwork system for clamshell insert cards: dielines, product data, GS1 barcodes, preflight and press-ready PDF export.",
  robots: { index: false, follow: false },
  icons: { icon: "/brand/mark-full-color.svg" },
};

export const viewport: Viewport = {
  themeColor: "#101215",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
