// Copies @ffmpeg/core ESM files to public/ffmpeg/ so Next.js can serve them
// from the same origin, avoiding webpack blob-URL resolution issues.
const { copyFileSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');

const srcDir = join(__dirname, '..', 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
const destDir = join(__dirname, '..', 'public', 'ffmpeg');

if (!existsSync(srcDir)) {
  console.log('[copy-ffmpeg] @ffmpeg/core not found, skipping.');
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });

for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  copyFileSync(join(srcDir, file), join(destDir, file));
  console.log(`[copy-ffmpeg] Copied ${file} → public/ffmpeg/${file}`);
}
