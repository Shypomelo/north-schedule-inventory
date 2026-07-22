import type { Metadata } from "next";
import { UserProvider } from "@/components/UserContext";
import { AuthGuard } from "@/components/AuthGuard";
import { LayoutContent } from "@/components/LayoutContent";
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
      </body>
    </html>
  );
}
