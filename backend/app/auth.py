"""Optional password gate for hosted deployments.

Set APP_PASSWORD to require a login. Without it (local use) everything is open.
The session cookie is an HMAC of the password, so changing APP_PASSWORD logs
everyone out.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

COOKIE = "ve_session"
OPEN_PATHS = {"/api/login", "/api/logout", "/api/session", "/api/health"}
PROTECTED_PREFIXES = ("/api/", "/files/")


def _password() -> str:
    return os.environ.get("APP_PASSWORD", "")


def _token() -> str:
    secret = os.environ.get("APP_SECRET", "") or _password()
    return hmac.new(secret.encode(), b"video-editor-session:" + _password().encode(),
                    hashlib.sha256).hexdigest()


def is_authenticated(request: Request) -> bool:
    if not _password():
        return True
    return hmac.compare_digest(request.cookies.get(COOKIE, ""), _token())


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if (request.method != "OPTIONS" and path.startswith(PROTECTED_PREFIXES)
                and path not in OPEN_PATHS and not is_authenticated(request)):
            return JSONResponse(status_code=401, content={"detail": "Login required"})
        return await call_next(request)


router = APIRouter()


class Login(BaseModel):
    password: str


@router.get("/api/session")
def session(request: Request) -> dict:
    return {"auth_required": bool(_password()), "authenticated": is_authenticated(request)}


@router.post("/api/login")
def login(body: Login, request: Request, response: Response) -> dict:
    if not _password():
        return {"ok": True}
    if not hmac.compare_digest(body.password.encode(), _password().encode()):
        time.sleep(1.0)  # slow down guessing
        raise HTTPException(401, "Wrong password")
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    # SameSite=None over HTTPS so login also works when the app is embedded (Hugging Face Spaces page)
    response.set_cookie(COOKIE, _token(), httponly=True, samesite="none" if secure else "lax",
                        secure=secure, max_age=30 * 24 * 3600)
    return {"ok": True}


@router.post("/api/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(COOKIE)
    return {"ok": True}
