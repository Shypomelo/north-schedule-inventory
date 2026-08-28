import type { Metadata } from "next";
import { UserProvider } from "@/components/UserContext";
import { AuthGuard } from "@/components/AuthGuard";
import { LayoutContent } from "@/components/LayoutContentV3";
import { ThemeProvider } from "@/components/ThemeContext";
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
    <html lang="zh-TW" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var savedTheme = localStorage.getItem('north-engineering-theme');
                if (savedTheme) {
                  document.documentElement.setAttribute('data-theme', savedTheme);
                } else {
                  document.documentElement.setAttribute('data-theme', 'dark');
                }
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body className="antialiased h-screen overflow-hidden flex">
        <ThemeProvider>
          <UserProvider>
            <AuthGuard>
              <LayoutContent>{children}</LayoutContent>
            </AuthGuard>
          </UserProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
