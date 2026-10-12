import type { Metadata } from 'next';
import { Geist } from 'next/font/google';

import './globals.css';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Pet Board v1.0',
  description: '通过 Web Serial 把图片和 GIF 传到 ESP32 设备的 SD 卡上，并按播放列表循环播放',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className={cn('font-sans', geist.variable)}>
      <body className="bg-background text-foreground min-h-dvh antialiased">
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
