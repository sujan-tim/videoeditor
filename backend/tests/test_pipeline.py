"""End-to-end test of the editing pipeline without calling Claude.

Generates synthetic footage with ffmpeg, then drives the API exactly as the
dashboard and the agent do: upload, edit via the tool registry, render,
validate, and restore a version.
"""
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

TMP = Path(tempfile.mkdtemp(prefix="ve-test-"))
os.environ["VIDEO_EDITOR_DATA_DIR"] = str(TMP / "data")
os.environ.pop("ANTHROPIC_API_KEY", None)

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.media import analysis  # noqa: E402
from app.storage import store  # noqa: E402

client = TestClient(app)


def make_video(path: Path, seconds: int, size: str, beeps: bool) -> Path:
    audio = ("aevalsrc='0.5*sin(2*PI*220*t)*lt(mod(t,3.5),2)':s=48000:d=%d" % seconds) if beeps \
        else f"sine=f=330:d={seconds}"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    f"testsrc2=size={size}:rate=30:duration={seconds}", "-f", "lavfi", "-i", audio,
                    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(path)],
                   check=True)
    return path


@pytest.fixture(scope="module")
def project():
    talk = make_video(TMP / "talk.mp4", 14, "1280x720", beeps=True)
    broll = make_video(TMP / "broll.mov", 4, "640x360", beeps=False)
    p = client.post("/api/projects", json={"name": "Test"}).json()
    pid = p["id"]
    for f in (talk, broll):
        with open(f, "rb") as fh:
            r = client.post(f"/api/projects/{pid}/sources", files={"file": (f.name, fh)})
        assert r.status_code == 200, r.text
    return pid


def tool(pid, name, **args):
    r = client.post(f"/api/projects/{pid}/tools/{name}", json={"args": args})
    return r


def wait_job(job_id):
    import time
    for _ in range(600):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.2)
    raise AssertionError("job timeout")


def test_upload_and_timeline(project):
    p = client.get(f"/api/projects/{project}").json()
    assert len(p["sources"]) == 2
    assert len(p["plan"]["clips"]) == 2
    assert abs(p["duration"] - 18) < 0.2


def test_rejects_bad_arguments(project):
    r = tool(project, "cut_range", start=5, end=2)
    assert r.status_code == 400 and "end must be greater" in r.json()["detail"]
    r = tool(project, "trim_clip", clip_id="clip_nope", start=1)
    assert r.status_code == 400
    r = tool(project, "add_text_overlay", text="hi", start=0, end=1, color="javascript:alert(1)")
    assert r.status_code == 400
    r = tool(project, "set_output_format", aspect="21:9")
    assert r.status_code == 400
    r = tool(project, "get_project", rm="-rf")  # unknown fields are rejected
    assert r.status_code == 400


def test_remove_silences(project):
    r = tool(project, "remove_silences")
    job = wait_job(r.json()["job"]["id"])
    assert job["status"] == "done", job
    p = client.get(f"/api/projects/{project}").json()
    # 14s source with 1.5s pauses every 3.5s: four pauses removed, minus padding
    assert p["duration"] < 14.5, p["duration"]
    assert len(p["plan"]["clips"]) >= 5


def test_edits_and_render(project):
    p = client.get(f"/api/projects/{project}").json()
    src_id = p["plan"]["clips"][0]["source_id"]
    src = p["sources"][src_id]
    pdir = store.project_dir(project)
    # Seed a transcript so subtitles can be tested without downloading Whisper.
    words = [{"start": s + i * 0.4, "end": s + i * 0.4 + 0.35, "word": w}
             for s in (0.0, 3.5, 7.0, 10.5) for i, w in enumerate(["hello", "there", "friends.", "ok"])]
    analysis.save_transcript(pdir / "analysis", pdir / src["path"],
                             {"language": "en", "segments": [{"start": 0, "end": 14, "text": "x",
                                                              "words": words}]})
    for other in p["sources"].values():
        if other["id"] != src_id:
            analysis.save_transcript(pdir / "analysis", pdir / other["path"],
                                     {"language": "en", "segments": []})
    assert tool(project, "set_output_format", platform="tiktok").status_code == 200
    assert tool(project, "add_text_overlay", text="Big news: it works", start=0, end=3).status_code == 200
    assert tool(project, "set_clip_volume", volume=0.8).status_code == 200
    r = tool(project, "set_subtitles", enabled=True, uppercase=True)
    assert wait_job(r.json()["job"]["id"])["status"] == "done"
    r = client.post(f"/api/projects/{project}/render", json={"mode": "preview"})
    job = wait_job(r.json()["job"]["id"])
    assert job["status"] == "done", job
    assert job["result"]["render"]["width"] == 540 and job["result"]["render"]["height"] == 960
    r = tool(project, "validate_render")
    job = wait_job(r.json()["job"]["id"])
    assert job["status"] == "done", job
    assert job["result"]["data"]["issues"] == [], job["result"]["data"]


def test_export_and_restore(project):
    r = client.post(f"/api/projects/{project}/render", json={"mode": "export", "quality": "draft"})
    job = wait_job(r.json()["job"]["id"])
    assert job["status"] == "done", job
    assert job["result"]["render"]["height"] == 1920
    p = client.get(f"/api/projects/{project}").json()
    r = client.post(f"/api/projects/{project}/versions/2/restore")
    assert r.status_code == 200
    restored = r.json()
    assert restored["version"] == p["version"] + 1
    assert len(restored["plan"]["clips"]) == 1


def test_originals_untouched(project):
    p = client.get(f"/api/projects/{project}").json()
    for s in p["sources"].values():
        f = store.project_dir(project) / s["path"]
        assert f.stat().st_size == s["size_bytes"]
        assert not os.access(f, os.W_OK) or os.geteuid() == 0


def test_chat_without_key(project):
    r = client.post(f"/api/projects/{project}/chat", json={"message": "make it 9:16"})
    wait_job(r.json()["job"]["id"])
    chat = client.get(f"/api/projects/{project}/chat").json()
    assert chat[-1]["role"] == "error" and "ANTHROPIC_API_KEY" in chat[-1]["text"]


def test_tool_schemas_exported():
    tools = client.get("/api/tools").json()
    names = {t["name"] for t in tools}
    assert {"get_project", "remove_silences", "set_subtitles", "render_preview",
            "propose_plan"} <= names
    for t in tools:
        assert t["input_schema"]["type"] == "object"
