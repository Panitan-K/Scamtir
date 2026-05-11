import path from 'path'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ]
  },
  webpack(config) {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false }

    // Replace @ffmpeg/ffmpeg's Vite-specific /* @vite-ignore */ comment with
    // /* webpackIgnore: true */ so webpack skips the dynamic coreURL import
    // and lets the browser's native import() handle it at runtime.
    config.module.rules.push({
      test: /worker\.js$/,
      include: /node_modules[\\/]@ffmpeg[\\/]ffmpeg/,
      loader: path.resolve('./loaders/ffmpeg-worker-loader.js'),
    })

    return config
  },
}

export default nextConfig
