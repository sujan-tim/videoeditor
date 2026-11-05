"""Entry point for the desktop app's bundled backend (built with PyInstaller).

The Electron shell starts this program with the port, data folder, FFmpeg and font paths in the
environment, then loads http://127.0.0.1:<port>/edit/ in its window. It only listens on localhost.
"""
import multiprocessing
import os
import sys


def main() -> None:
    os.environ.setdefault("DESKTOP_MODE", "1")
    os.environ.setdefault("WHISPER_MODEL", "base")
    port = int(os.environ.get("VIDEO_EDITOR_PORT") or (sys.argv[1] if len(sys.argv) > 1 else 8765))

    import uvicorn

    from app.main import app

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    multiprocessing.freeze_support()  # needed by PyInstaller on Windows
    main()
