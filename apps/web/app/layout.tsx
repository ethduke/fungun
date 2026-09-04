import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fungun — Launch a coin',
  icons: { icon: '/favicon.svg' },
  description:
    'Create a coin and choose Long, O1, or both. Noncustodial launch composer.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
