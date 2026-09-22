import "./globals.css";

export const metadata = {
  title: "News Pulse",
  description: "Topic-clustered news timeline",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 min-h-screen">{children}</body>
    </html>
  );
}
