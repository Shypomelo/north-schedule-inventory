import type { Metadata } from "next";
import { UserProvider } from "@/components/UserContext";
import { Sidebar } from "@/components/Sidebar";
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
          <Sidebar />
          <main className="flex-1 h-full overflow-auto custom-scrollbar bg-slate-900 relative">
            <div className="min-w-[1400px] h-full">
              {children}
            </div>
          </main>
        </UserProvider>
      </body>
    </html>
  );
}
