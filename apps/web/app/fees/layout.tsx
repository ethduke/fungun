import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Fungun — Fees' };

export default function FeesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
