import type { Metadata, Viewport } from 'next';
import './globals.css';
import AppSidebar from '@/components/AppSidebar';
import BrowserKeepalive from '@/components/BrowserKeepalive';
import { Geist } from 'next/font/google';
import { cn } from '@/lib/utils';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { PerformanceProvider } from '@/contexts/PerformanceContext';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Needle (觅针) — 视频订阅追踪',
  description: '本地视频订阅追踪与 AI 总结，支持 YouTube 和 B站',
  manifest: '/manifest.json',
  icons: {
    icon: '/logo.jpeg',
    apple: '/logo.jpeg',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Needle',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f9f9f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0f0f0f' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

// Inline script to apply theme before first paint (prevents FOUC)
const themeScript = `
(function() {
  try {
    var stored = localStorage.getItem('theme');
    var isDark = stored === 'dark' || (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) document.documentElement.classList.add('dark');
  } catch(e) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh" className={cn('font-sans', geist.variable)}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <BrowserKeepalive />
        <PerformanceProvider>
          <ThemeProvider>
            <div className="app-shell">
              <div className="app-main-wrapper">
                <AppSidebar />
                <main className="main-content">{children}</main>
              </div>
            </div>
          </ThemeProvider>
        </PerformanceProvider>
      </body>
    </html>
  );
}
