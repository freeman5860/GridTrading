import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "网格交易助手",
  description: "上传截图或输入文字，AI 按网格交易规则给出操作建议",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
