import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
const manrope = localFont({ src: './fonts/Manrope-Variable.ttf', variable: '--font-ui', display: 'swap', weight: '200 800' });
export const metadata: Metadata = {
  title: 'Lockinder — Find your Deadlock duo',
  description: 'Find Deadlock teammates who speak your language and play at your level. Sign in with Steam and connect on Discord.'
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={manrope.variable} suppressHydrationWarning><body>{children}</body></html>;
}
