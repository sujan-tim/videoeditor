// Desktop shell: starts the bundled editor backend (FFmpeg, AI tools, renderer) on localhost and shows
// the same editor UI as the website in a native window. Everything runs on this computer.
const { app, BrowserWindow, dialog, shell, Menu } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");

let backend = null;
let win = null;
let port = 0;
let quitting = false;

const resources = () => (app.isPackaged ? process.resourcesPath : path.join(__dirname, ".."));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function backendCommand() {
  const exe = process.platform === "win32" ? "videoeditor-server.exe" : "videoeditor-server";
  const bundled = path.join(resources(), "backend", exe);
  if (fs.existsSync(bundled)) return { cmd: bundled, args: [], cwd: path.dirname(bundled) };
  // development: run the Python backend from the repo
  const repoBackend = path.join(__dirname, "..", "backend");
  const py = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  return { cmd: py, args: ["desktop_server.py"], cwd: repoBackend };
}

function startBackend() {
  const dataDir = path.join(app.getPath("userData"), "data");
  const logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const frontend = app.isPackaged ? path.join(resources(), "frontend") : path.join(__dirname, "..", "frontend", "out");
  const font = app.isPackaged ? path.join(resources(), "fonts", "DejaVuSans-Bold.ttf") : path.join(__dirname, "assets", "DejaVuSans-Bold.ttf");
  const env = {
    ...process.env,
    DESKTOP_MODE: "1",
    VIDEO_EDITOR_PORT: String(port),
    VIDEO_EDITOR_DATA_DIR: dataDir,
    FRONTEND_DIR: frontend,
    OVERLAY_FONT: font,
    MAX_UPLOAD_BYTES: String(20 * 1024 ** 3),
    PYTHONUNBUFFERED: "1",
  };
  const ext = process.platform === "win32" ? ".exe" : "";
  const binDir = path.join(app.isPackaged ? resources() : __dirname, "bin");
  if (fs.existsSync(path.join(binDir, "ffmpeg" + ext))) {
    env.FFMPEG_BIN = path.join(binDir, "ffmpeg" + ext);
    env.FFPROBE_BIN = path.join(binDir, "ffprobe" + ext);
  }
  const { cmd, args, cwd } = backendCommand();
  const log = fs.createWriteStream(path.join(logDir, "backend.log"), { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} starting ${cmd} on port ${port}\n`);
  backend = spawn(cmd, args, { cwd, env, windowsHide: true });
  backend.stdout.pipe(log);
  backend.stderr.pipe(log);
  backend.on("exit", (code) => {
    log.write(`--- backend exited with ${code}\n`);
    backend = null;
    if (!quitting) {
      dialog.showErrorBox("AI Video Editor stopped", `The editor engine stopped unexpectedly (code ${code}).\nLog: ${path.join(logDir, "backend.log")}`);
      app.quit();
    }
  });
}

function waitForHealth(timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tryOnce, 400);
    };
    tryOnce();
  });
}

function isLocal(url) {
  try {
    const u = new URL(url);
    return u.hostname === "127.0.0.1" && u.port === String(port);
  } catch {
    return false;
  }
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#09090b",
    title: "AI Video Editor",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // links to other sites (Groq key page, GitHub) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocal(url)) shell.openExternal(url);
    return { action: isLocal(url) ? "allow" : "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isLocal(url) && !url.startsWith("file:")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  await win.loadFile(path.join(__dirname, "loading.html"));
  try {
    await waitForHealth(120000);
  } catch {
    dialog.showErrorBox("AI Video Editor could not start", `The editor engine did not start in time.\nLog: ${path.join(app.getPath("userData"), "logs", "backend.log")}`);
    app.quit();
    return;
  }
  await win.loadURL(`http://127.0.0.1:${port}/edit/`);
}

function stopBackend() {
  quitting = true;
  if (backend) {
    try {
      backend.kill();
    } catch {}
    backend = null;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
        { role: "fileMenu" },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }],
        },
        {
          label: "Help",
          submenu: [
            { label: "Open data folder", click: () => shell.openPath(path.join(app.getPath("userData"), "data")) },
            { label: "Open logs", click: () => shell.openPath(path.join(app.getPath("userData"), "logs")) },
            { label: "Get a free Groq key", click: () => shell.openExternal("https://console.groq.com/keys") },
          ],
        },
      ]),
    );
    port = await freePort();
    startBackend();
    await createWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", stopBackend);
  process.on("exit", stopBackend);
}
