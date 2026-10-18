import type { Metadata } from 'next';
import '../styles/globals.css';
export const metadata: Metadata = { title: 'Faultline — responsibility & recovery', description: 'Trace the failed commitment. Fund the repair. Verify recovery.' };
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) { return <html lang="en"><body>{children}</body></html>; }
