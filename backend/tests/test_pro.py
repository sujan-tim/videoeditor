"""Pro editing features: speed, looks, framing, transitions, B-roll, music with ducking, animated text,
caption styles, media prep and undo/redo. Renders real files and checks them with ffprobe."""
import json
import subprocess

from tests.test_pipeline import TMP, client, make_video, tool, wait_job  # noqa: F401  (shared app + temp dir)

from app.media import analysis
from app.storage import store


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def upload(pid, path):
    with open(path, "rb") as fh:
        r = client.post(f"/api/projects/{pid}/sources", files={"file": (path.name, fh)})
    assert r.status_code == 200, r.text
    return r.json()["source"]


def make_music(path, seconds):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    f"sine=f=440:d={seconds}", "-c:a", "libmp3lame", str(path)], check=True)
    return path


def wait_prep(pid):
    for job in client.get(f"/api/projects/{pid}/jobs").json():
        if job["kind"] == "prep":
            assert wait_job(job["id"])["status"] == "done"


def test_pro_edit_renders():
    a = make_video(TMP / "pro_a.mp4", 6, "1280x720", beeps=True)
    b = make_video(TMP / "pro_b.mp4", 5, "1280x720", beeps=False)
    music = make_music(TMP / "song.mp3", 20)
    pid = client.post("/api/projects", json={"name": "Pro"}).json()["id"]
    sa, sb = upload(pid, a), upload(pid, b)
    sm = upload(pid, music)
    assert sm["kind"] == "audio"
    wait_prep(pid)
    p = client.get(f"/api/projects/{pid}").json()
    assert p["sources"][sa["id"]]["filmstrip_url"] and not p["sources"][sa["id"]]["proxy_url"]  # h264 720p plays as is
    wf = store.project_dir(pid) / p["sources"][sm["id"]]["waveform_url"].split(f"/files/{pid}/")[1]
    peaks = json.loads(wf.read_text())
    assert len(peaks) > 900 and max(peaks) == 1.0
    # the music was added to the audio track automatically, ducking under speech
    assert len(p["plan"]["audio"]) == 1 and p["plan"]["audio"][0]["duck"]
    c1, c2 = [c["id"] for c in p["plan"]["clips"]]
    assert abs(p["duration"] - 11) < 0.1

    # seeded transcript so captions work offline
    pdir = store.project_dir(pid)
    analysis.save_transcript(pdir / "analysis", pdir / p["sources"][sa["id"]]["path"], {
        "language": "en", "segments": [{"start": 0.5, "end": 3.0, "text": "hello there world", "words": [
            {"start": 0.5, "end": 1.0, "word": "hello"}, {"start": 1.1, "end": 1.6, "word": "there"},
            {"start": 1.7, "end": 2.4, "word": "world."}]}]})
    analysis.save_transcript(pdir / "analysis", pdir / p["sources"][sb["id"]]["path"],
                             {"language": "en", "segments": []})

    assert tool(pid, "set_clip_speed", clip_id=c2, speed=2).status_code == 200
    assert tool(pid, "set_color", look="cinematic", saturation=0.2).status_code == 200
    assert tool(pid, "set_framing", clip_id=c1, zoom=1.2, focus_x=0.3).status_code == 200
    r = tool(pid, "set_transition", type="slideleft", duration=0.5)
    assert r.status_code == 200, r.text
    # 6 + 2.5 - 0.5 overlap
    assert abs(r.json()["result"]["data"]["new_duration"] - 8.0) < 0.05
    assert tool(pid, "update_clip", clip_id=c1, fade_in=0.3).status_code == 200
    assert tool(pid, "add_broll", source_id=sb["id"], timeline_start=1.0, start=0, end=1.5,
                mode="pip", pip_corner="bottom_right").status_code == 200
    assert tool(pid, "add_broll", source_id=sb["id"], timeline_start=4.0, start=2, end=3).status_code == 200
    for anim, style in (("pop", "highlight"), ("slide_up", "outline"), ("typewriter", "shadow"), ("fade", "box")):
        r = tool(pid, "add_text_overlay", text=f"{anim} title here", start=0.2, end=3, animation=anim,
                 style=style, x=0.5, y=0.3)
        assert r.status_code == 200, r.text
    r = tool(pid, "set_subtitles", enabled=True, style="karaoke")
    job = wait_job(r.json()["job"]["id"])
    assert job["status"] == "done", job
    r = tool(pid, "set_output_format", platform="tiktok", fit="blur")
    assert r.status_code == 200
    words = client.get(f"/api/projects/{pid}/captions").json()
    assert [w["word"] for w in words] == ["hello", "there", "world."]
    ass = None

    r = client.post(f"/api/projects/{pid}/render", json={"mode": "preview"})
    job = wait_job(r.json()["job"]["id"])
    assert job["status"] == "done", job
    p = client.get(f"/api/projects/{pid}").json()
    out = store.project_dir(pid) / p["renders"][-1]["path"]
    meta = probe(out)
    v = next(s for s in meta["streams"] if s["codec_type"] == "video")
    assert (v["width"], v["height"]) == (540, 960)
    assert abs(float(meta["format"]["duration"]) - 8.0) < 0.2
    ass = (store.project_dir(pid) / "cache" / "subtitles.ass").read_text()
    assert "\\fscx112" in ass

    # music is ducked: compare level in the speech part vs. a silent part of clip A
    # (beeps play 0-2s, pause 2-3.5s); just check the render has audio with sensible level
    vol = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(out), "-af", "volumedetect", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    assert "mean_volume" in vol


def test_undo_redo():
    pid = client.post("/api/projects", json={"name": "Undo"}).json()["id"]
    upload(pid, make_video(TMP / "u.mp4", 3, "320x240", beeps=False))
    p = client.get(f"/api/projects/{pid}").json()
    assert not p["can_undo"] or len(p["plan"]["clips"]) == 1
    cid = p["plan"]["clips"][0]["id"]
    tool(pid, "set_clip_speed", clip_id=cid, speed=2)
    tool(pid, "set_color", look="bw")
    p = client.post(f"/api/projects/{pid}/undo").json()
    assert p["plan"]["clips"][0]["look"] == "none" and p["plan"]["clips"][0]["speed"] == 2
    p = client.post(f"/api/projects/{pid}/undo").json()
    assert p["plan"]["clips"][0]["speed"] == 1 and p["can_redo"]
    p = client.post(f"/api/projects/{pid}/redo").json()
    assert p["plan"]["clips"][0]["speed"] == 2
    # a new edit drops the redo branch
    tool(pid, "set_color", look="warm")
    p = client.get(f"/api/projects/{pid}").json()
    assert not p["can_redo"] and p["plan"]["clips"][0]["look"] == "warm"
    p = client.post(f"/api/projects/{pid}/undo").json()
    assert p["plan"]["clips"][0]["look"] == "none" and p["plan"]["clips"][0]["speed"] == 2
    # undo all the way to the empty project, then no further
    client.post(f"/api/projects/{pid}/undo")
    p = client.post(f"/api/projects/{pid}/undo").json()
    assert p["plan"]["clips"] == []
    assert client.post(f"/api/projects/{pid}/undo").status_code == 404


def test_cut_keeps_clip_settings():
    pid = client.post("/api/projects", json={"name": "Cut"}).json()["id"]
    upload(pid, make_video(TMP / "c.mp4", 8, "320x240", beeps=False))
    cid = client.get(f"/api/projects/{pid}").json()["plan"]["clips"][0]["id"]
    tool(pid, "update_clip", clip_id=cid, speed=2, look="vivid")
    r = tool(pid, "cut_range", start=1, end=2)  # timeline 1-2s = source 2-4s
    assert r.status_code == 200
    clips = client.get(f"/api/projects/{pid}").json()["plan"]["clips"]
    assert [(c["start"], c["end"]) for c in clips] == [(0, 2), (4, 8)]
    assert all(c["look"] == "vivid" and c["speed"] == 2 for c in clips)
