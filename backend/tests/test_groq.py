"""Free AI editor on Groq, with the Groq API faked (no network, no key needed)."""
import json
import os

import httpx
import pytest

from tests.test_pipeline import TMP, client, make_video, wait_job  # noqa: F401  (shared app + data dir)
from app.agent import groq_agent
from app.ai import groq
from app.media import analysis


@pytest.fixture()
def groq_env(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    yield


def reply(obj):
    return {"choices": [{"message": {"content": json.dumps(obj)}}]}


def test_groq_agent_batches_tools_and_recovers(groq_env, monkeypatch):
    calls = []
    script = [
        reply({"reply": "Checking pauses.", "done": False, "actions": [
            {"tool": "set_output_format", "args": {"platform": "tiktok"}},
            {"tool": "cut_range", "args": {"start": 3, "end": 1}},
            {"tool": "rm_rf", "args": {}}]}),
        {"choices": [{"message": {"content": "```json\n" + json.dumps({"reply": "Made it 9:16 with a cinematic look.", "done": True, "actions": [
            {"tool": "set_color", "args": {"look": "cinematic"}}]}) + "\n```"}}]},
    ]

    def fake_chat(messages, model, **kw):
        calls.append({"messages": messages, "model": model, **kw})
        return script.pop(0)

    monkeypatch.setattr(groq, "chat", fake_chat)
    video = make_video(TMP / "groq.mp4", 4, "640x360", beeps=False)
    pid = client.post("/api/projects", json={"name": "Groq"}).json()["id"]
    with open(video, "rb") as fh:
        client.post(f"/api/projects/{pid}/sources", files={"file": ("groq.mp4", fh)})
    health = client.get("/api/health").json()
    assert health["ai_provider"] == "groq" and health["ai_configured"] and health["ai_model"] == "openai/gpt-oss-120b"

    r = client.post(f"/api/projects/{pid}/chat", json={"message": "make it a tiktok"})
    job = wait_job(r.json()["job"]["id"])
    assert job["status"] == "done", job
    p = client.get(f"/api/projects/{pid}").json()
    assert p["plan"]["output"]["aspect"] == "9:16"
    assert p["plan"]["clips"][0]["look"] == "cinematic"

    chat = client.get(f"/api/projects/{pid}/chat").json()
    assert chat[-1] == {**chat[-1], "role": "assistant", "text": "Made it 9:16 with a cinematic look."}
    bad = [m for m in chat if m.get("tool") == "cut_range"][0]
    assert bad["ok"] is False
    unknown = [m for m in chat if m.get("tool") == "rm_rf"][0]
    assert unknown["ok"] is False and "Unknown tool" in unknown["summary"]

    # frugal requests: compact catalogue, project state included, results fed back in round 2
    system = calls[0]["messages"][0]["content"]
    assert "set_transition(" in system and "sample_frames" not in system
    assert len(system) < 12000
    assert "PROJECT STATE" in calls[0]["messages"][-1]["content"]
    assert "ERROR" in calls[1]["messages"][-1]["content"] and "Unknown tool" in calls[1]["messages"][-1]["content"]

    # memory of earlier turns is kept, compactly
    hist = json.loads((groq_agent._history_path(pid)).read_text())
    assert hist[0] == {"role": "user", "content": "make it a tiktok"}


def test_groq_not_configured(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    pid = client.post("/api/projects", json={"name": "NoKey"}).json()["id"]
    r = client.post(f"/api/projects/{pid}/chat", json={"message": "hi"})
    wait_job(r.json()["job"]["id"])
    chat = client.get(f"/api/projects/{pid}/chat").json()
    assert chat[-1]["role"] == "error" and "console.groq.com" in chat[-1]["text"]


def test_rate_limit_retry(groq_env, monkeypatch):
    responses = [httpx.Response(429, headers={"retry-after": "0.01"}, json={"error": {"message": "slow down"}}),
                 httpx.Response(200, json=reply({"reply": "hi", "actions": []}))]
    monkeypatch.setattr(httpx, "post", lambda *a, **k: responses.pop(0))
    monkeypatch.setattr(groq.time, "sleep", lambda s: None)
    out = groq.chat([{"role": "user", "content": "x"}], "openai/gpt-oss-120b")
    assert json.loads(out["choices"][0]["message"]["content"])["reply"] == "hi"
    monkeypatch.setattr(httpx, "post", lambda *a, **k: httpx.Response(401, json={"error": {"message": "Invalid API Key"}}))
    with pytest.raises(groq.GroqError) as e:
        groq.chat([], "m")
    assert e.value.status == 401


def test_cloud_transcription_merges_chunks(groq_env, monkeypatch):
    video = make_video(TMP / "talk_groq.mp4", 5, "320x240", beeps=True)
    monkeypatch.setattr(analysis, "CHUNK_SECONDS", 3)
    seen = []

    def fake_transcribe(path, model, language=None, on_wait=None):
        seen.append(path.stat().st_size)
        return {"language": "english", "segments": [{"start": 0.2, "end": 1.0, "text": " hi there"}],
                "words": [{"word": " hi", "start": 0.2, "end": 0.5}, {"word": "there", "start": 0.6, "end": 1.0}]}

    monkeypatch.setattr(groq, "transcribe_file", fake_transcribe)
    cache = TMP / "groq_cache"
    tr = analysis.transcribe(video, cache, duration=5.0)
    assert len(seen) == 2 and all(s > 0 for s in seen)
    assert [s["start"] for s in tr["segments"]] == [0.2, 3.2]
    assert tr["segments"][1]["words"][0] == {"start": 3.2, "end": 3.5, "word": "hi"}
    assert analysis.load_transcript(cache, video) == tr  # cached
