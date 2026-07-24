import type { Metadata } from "next";
import { UserProvider } from "@/components/UserContext";
import { AuthGuard } from "@/components/AuthGuard";
import { LayoutContent } from "@/components/LayoutContentV3";
import "./globals.css";

export const metadata: Metadata = {
  title: "北部工程排程與庫存管理系統",
  description: "Schedule and Inventory Management System",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-TW">
      <body className="antialiased h-screen overflow-hidden bg-slate-900 text-slate-50 flex">
        <UserProvider>
          <AuthGuard>
            <LayoutContent>{children}</LayoutContent>
          </AuthGuard>
        </UserProvider>
        <div style={{ position: 'fixed', right: '12px', bottom: '12px', background: 'red', color: 'white', zIndex: 99999, fontSize: '12px', padding: '6px 8px', borderRadius: '6px' }}>
          BUILD MARKER: 2026-07-25-VERCEL-DEBUG-01
        </div>
      </body>
    </html>
  );
}
