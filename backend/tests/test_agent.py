"""Agent loop test with a scripted fake Claude client (no network, no API key needed)."""
import os
import types

import pytest
from anthropic.types.beta import BetaTextBlock, BetaToolUseBlock

from tests.test_pipeline import client, make_video, TMP, wait_job  # noqa: F401  (shared app + data dir)
from app.agent import agent


class FakeMessages:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        blocks, stop = self.script.pop(0)
        return types.SimpleNamespace(content=blocks, stop_reason=stop)


@pytest.fixture()
def fake(monkeypatch):
    os.environ["ANTHROPIC_API_KEY"] = "test-key"
    script = [
        ([BetaTextBlock(type="text", text="Let me look."),
          BetaToolUseBlock(type="tool_use", id="tu_1", name="get_project", input={})], "tool_use"),
        ([BetaToolUseBlock(type="tool_use", id="tu_2", name="set_output_format",
                           input={"platform": "instagram_reels"}),
          BetaToolUseBlock(type="tool_use", id="tu_3", name="cut_range",
                           input={"start": 3, "end": 1})], "tool_use"),
        ([BetaTextBlock(type="text", text="Done: the video is now 9:16.")], "end_turn"),
    ]
    messages = FakeMessages(script)
    fake_client = types.SimpleNamespace(beta=types.SimpleNamespace(messages=messages))
    monkeypatch.setattr(agent, "_client", lambda: fake_client)
    yield messages
    os.environ.pop("ANTHROPIC_API_KEY", None)


def test_agent_runs_tools_and_reports(fake):
    video = make_video(TMP / "agent.mp4", 5, "640x360", beeps=False)
    pid = client.post("/api/projects", json={"name": "Agent"}).json()["id"]
    with open(video, "rb") as fh:
        client.post(f"/api/projects/{pid}/sources", files={"file": ("agent.mp4", fh)})
    r = client.post(f"/api/projects/{pid}/chat", json={"message": "Make it a reel"})
    job = wait_job(r.json()["job"]["id"])
    assert job["status"] == "done", job

    p = client.get(f"/api/projects/{pid}").json()
    assert p["plan"]["output"]["aspect"] == "9:16"
    assert p["history"][-1]["actor"] == "agent"

    chat = client.get(f"/api/projects/{pid}/chat").json()
    roles = [m["role"] for m in chat]
    assert roles[0] == "user" and roles[-1] == "assistant"
    bad = [m for m in chat if m.get("tool") == "cut_range"][0]
    assert bad["ok"] is False and "end must be greater" in bad["summary"]

    # Parallel tool results go back in ONE user message, with the error flagged.
    third_call = fake.calls[2]["messages"]
    results = third_call[-2]["content"]  # list is shared; the final reply was appended after
    assert [b["tool_use_id"] for b in results] == ["tu_2", "tu_3"]
    assert results[1]["is_error"] is True
    assert fake.calls[0]["model"] == "claude-opus-5-5"
    assert fake.calls[0]["thinking"] == {"type": "adaptive"}
