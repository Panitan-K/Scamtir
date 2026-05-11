// Replaces @ffmpeg/ffmpeg's Vite-specific ignore comment with the webpack
// equivalent so webpack doesn't try to resolve the dynamic coreURL import.
module.exports = function ffmpegWorkerLoader(source) {
  return source.replace('/* @vite-ignore */', '/* webpackIgnore: true */');
};
