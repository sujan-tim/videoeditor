"""Password gate for hosted deployments."""
import os

from tests.test_pipeline import client  # shared app


def test_password_gate():
    os.environ["APP_PASSWORD"] = "s3cret"
    try:
        client.cookies.clear()
        assert client.get("/api/session").json() == {"auth_required": True, "authenticated": False}
        assert client.get("/api/projects").status_code == 401
        assert client.get("/files/anything.mp4").status_code == 401
        assert client.post("/api/login", json={"password": "nope"}).status_code == 401
        assert client.post("/api/login", json={"password": "s3cret"}).status_code == 200
        assert client.get("/api/projects").status_code == 200
    finally:
        os.environ.pop("APP_PASSWORD")
        client.cookies.clear()
    assert client.get("/api/projects").status_code == 200
