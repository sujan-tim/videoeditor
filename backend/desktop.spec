# PyInstaller spec for the desktop backend:  pyinstaller desktop.spec
# Produces dist/videoeditor-server/ (a folder with the executable and its libraries).
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas, binaries, hiddenimports = [], [], []
for pkg in ("faster_whisper", "ctranslate2", "scenedetect", "tokenizers", "onnxruntime", "av"):
    try:
        d, b, h = collect_all(pkg)
    except Exception:  # package missing on this platform
        continue
    datas += d
    binaries += b
    hiddenimports += h
hiddenimports += collect_submodules("app") + collect_submodules("uvicorn") + [
    "anthropic", "httpx", "multipart", "python_multipart",
]

a = Analysis(
    ["desktop_server.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "IPython", "matplotlib"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="videoeditor-server", console=True)
coll = COLLECT(exe, a.binaries, a.datas, name="videoeditor-server")
