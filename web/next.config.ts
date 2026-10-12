import type { NextConfig } from 'next';

// GitHub Pages 的项目页挂在 /<repo>/ 下，CI 会把仓库名塞进这个环境变量。
// 本地开发（pnpm dev）留空就是根路径。
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const nextConfig: NextConfig = {
  output: 'export',
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
