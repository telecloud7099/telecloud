import os
import secrets
import time
import logging
from typing import Optional
from fastapi import Request, Response, HTTPException, Depends

logger = logging.getLogger(__name__)

SESSION_TIMEOUT = int(os.getenv("SESSION_TIMEOUT", "604800"))  # 7 days default
IS_SECURE = os.getenv("SECURE_COOKIES", "false").lower() == "true"

# token → {phone, created_at, last_active}  — populated from DB on first use
_sessions: dict[str, dict] = {}
_sessions_loaded = False


def _ensure_loaded():
    global _sessions, _sessions_loaded
    if not _sessions_loaded:
        try:
            from backend.database import load_all_sessions
            _sessions = load_all_sessions()
        except Exception as e:
            logger.warning(f"Could not load sessions from DB: {e}")
        _sessions_loaded = True


# ── Session management ────────────────────────────────────────────────────────

def create_session(phone: str) -> str:
    _ensure_loaded()
    from backend.database import persist_session
    token = secrets.token_urlsafe(32)
    now = time.time()
    _sessions[token] = {"phone": phone, "created_at": now, "last_active": now}
    persist_session(token, phone, now, now)
    return token


def get_session_data(token: Optional[str]) -> Optional[dict]:
    _ensure_loaded()
    if not token or token not in _sessions:
        return None
    sess = _sessions[token]
    if time.time() - sess["last_active"] > SESSION_TIMEOUT:
        del _sessions[token]
        from backend.database import remove_session
        remove_session(token)
        return None
    sess["last_active"] = time.time()
    from backend.database import persist_session
    persist_session(token, sess["phone"], sess["created_at"], sess["last_active"])
    return sess


def destroy_session(token: Optional[str]):
    _ensure_loaded()
    if token:
        _sessions.pop(token, None)
        from backend.database import remove_session
        remove_session(token)


def cleanup_expired_sessions() -> list[str]:
    _ensure_loaded()
    now = time.time()
    expired_tokens = [t for t, s in _sessions.items() if now - s["last_active"] > SESSION_TIMEOUT]
    expired_phones = [_sessions[t]["phone"] for t in expired_tokens]
    for t in expired_tokens:
        del _sessions[t]
        from backend.database import remove_session
        remove_session(t)
    still_active = {s["phone"] for s in _sessions.values()}
    return [p for p in expired_phones if p not in still_active]


# ── FastAPI dependency ────────────────────────────────────────────────────────

def get_current_user(request: Request) -> str:
    token = request.cookies.get("session_token")
    sess = get_session_data(token)
    if not sess:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return sess["phone"]


# ── CSRF helpers ─────────────────────────────────────────────────────────────

def check_csrf(request: Request):
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    cookie_val = request.cookies.get("csrf_token")
    header_val = request.headers.get("X-CSRF-Token")
    if not cookie_val or cookie_val != header_val:
        raise HTTPException(status_code=403, detail="CSRF validation failed")


def set_auth_cookies(response: Response, phone: str) -> str:
    token = create_session(phone)
    csrf = secrets.token_urlsafe(32)
    response.set_cookie(
        "session_token", token,
        httponly=True, samesite="lax",
        secure=IS_SECURE, max_age=SESSION_TIMEOUT, path="/",
    )
    response.set_cookie(
        "csrf_token", csrf,
        httponly=False, samesite="lax",
        secure=IS_SECURE, max_age=SESSION_TIMEOUT, path="/",
    )
    return token


def set_csrf_if_missing(request: Request, response: Response):
    if "csrf_token" not in request.cookies:
        token = secrets.token_urlsafe(32)
        response.set_cookie(
            "csrf_token", token,
            httponly=False, samesite="lax",
            secure=IS_SECURE, max_age=86400, path="/",
        )
