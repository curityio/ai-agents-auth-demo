import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Figtree, Roboto_Mono } from 'next/font/google';
import './globals.css';

const sans = Figtree({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-sans',
});

const mono = Roboto_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'SRE Copilot — AI Agent Auth Demo',
  description:
    'A DevOps copilot that reads observability data and restarts workloads on a user’s behalf — every hop authenticated, least-privilege, MFA-gated, and traceable.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="bg-app min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
