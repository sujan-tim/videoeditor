// Where the desktop installers are published (GitHub Releases of the public repo).
export const REPO = "sujan-tim/videoeditor";
const latest = `https://github.com/${REPO}/releases/latest/download`;

export type Download = { os: "windows" | "mac-arm" | "mac-intel" | "linux"; label: string; detail: string; file: string; url: string };

export const DOWNLOADS: Download[] = [
  { os: "windows", label: "Windows", detail: "Windows 10 and 11, 64-bit", file: "AI-Video-Editor-Setup-x64.exe", url: `${latest}/AI-Video-Editor-Setup-x64.exe` },
  { os: "mac-arm", label: "macOS (Apple silicon)", detail: "M1, M2, M3, M4 Macs", file: "AI-Video-Editor-mac-arm64.dmg", url: `${latest}/AI-Video-Editor-mac-arm64.dmg` },
  { os: "mac-intel", label: "macOS (Intel)", detail: "Intel Macs", file: "AI-Video-Editor-mac-x64.dmg", url: `${latest}/AI-Video-Editor-mac-x64.dmg` },
  { os: "linux", label: "Linux", detail: "AppImage, 64-bit", file: "AI-Video-Editor-linux-x86_64.AppImage", url: `${latest}/AI-Video-Editor-linux-x86_64.AppImage` },
];
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

export function detectOS(): Download["os"] | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) {
    // Browsers report Intel in the UA even on Apple silicon; WebGL renderer tells them apart.
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      const renderer = info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
      if (/Apple M|Apple GPU/i.test(renderer)) return "mac-arm";
      if (/Intel|AMD|Radeon/i.test(renderer)) return "mac-intel";
    } catch {}
    return "mac-arm";
  }
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return null;
}
