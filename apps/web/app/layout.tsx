import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import { quicksand } from '@/lib/fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fungun — Launch a coin',
  icons: {
    shortcut: '/favicon.ico',
    icon: [
      { url: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
      { url: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
      { url: '/brand/fungun-icon.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: { url: '/apple-touch-icon.png', sizes: '180x180' },
  },
  description:
    'Create a coin on Robinhood Chain with Long, O1, or Longbow. Noncustodial launch composer.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={quicksand.variable}>
      <head>
        <link rel="describedby" href="/llms.txt" type="text/plain" />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
