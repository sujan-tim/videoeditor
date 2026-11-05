// Copy this platform's FFmpeg and FFprobe into desktop/bin so electron-builder ships only those two.
const fs = require("fs");
const path = require("path");

const out = path.join(__dirname, "..", "bin");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const ext = process.platform === "win32" ? ".exe" : "";
for (const [name, src] of [
  ["ffmpeg", require("ffmpeg-static")],
  ["ffprobe", require("ffprobe-static").path],
]) {
  if (!src || !fs.existsSync(src)) throw new Error(`${name} binary not found for ${process.platform}/${process.arch}`);
  const dest = path.join(out, name + ext);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  console.log(`${name}: ${src} -> ${dest}`);
}
