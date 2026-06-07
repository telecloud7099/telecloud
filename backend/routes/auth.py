import os
import secrets
import logging
from fastapi import APIRouter, Request, Response, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from telethon.errors import SessionPasswordNeededError, AuthRestartError

from backend.auth import (
    get_current_user, check_csrf, set_auth_cookies,
    destroy_session, get_session_data,
)
from backend.database import (
    get_api_credentials, save_api_session,
    delete_api_session, delete_all_folders,
)
from backend.telegram_client import get_client, remove_client, session_file_exists
from backend.security import (
    rate_limit_check, validate_phone_number, sanitize_input, log_security_event,
)
from backend.cache import cache_invalidate

router = APIRouter()
logger = logging.getLogger(__name__)

# phone → phone_code_hash (pre-auth only)
phone_code_hashes: dict[str, str] = {}


# ── Request models ────────────────────────────────────────────────────────────

class SetupApiRequest(BaseModel):
    api_id: int
    api_hash: str


class SendCodeRequest(BaseModel):
    phone: str


class VerifyCodeRequest(BaseModel):
    phone: str
    code: str


class VerifyPasswordRequest(BaseModel):
    phone: str
    password: str


# ── Public check — no auth needed ────────────────────────────────────────────

@router.get("/has-setup")
async def has_setup(request: Request):
    sid = request.cookies.get("tc_api_session")
    api_id, _ = get_api_credentials(sid)
    return {"configured": bool(api_id)}


# ── Setup ─────────────────────────────────────────────────────────────────────

@router.post("/setup-api")
async def setup_api(request: Request, response: Response, body: SetupApiRequest):
    rl = await rate_limit_check(request)
    if rl:
        return rl
    check_csrf(request)

    if body.api_id <= 0:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API ID must be a positive number"})
    if not body.api_hash or len(body.api_hash.strip()) < 16:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API Hash looks too short"})

    sid = request.cookies.get("tc_api_session") or secrets.token_urlsafe(32)
    ttl = int(os.getenv("API_SESSION_TTL", "604800"))

    save_api_session(
        sid=sid,
        api_id=body.api_id,
        api_hash=body.api_hash.strip(),
        ip=request.client.host,
        ua=request.headers.get("User-Agent", ""),
    )

    response.set_cookie(
        "tc_api_session", sid,
        httponly=True, samesite="lax",
        secure=False, max_age=ttl, path="/",
    )
    return {"status": "success"}


# ── Auth flow ─────────────────────────────────────────────────────────────────

@router.post("/send_code")
async def send_code(request: Request, body: SendCodeRequest):
    rl = await rate_limit_check(request)
    if rl:
        return rl
    check_csrf(request)

    sid = request.cookies.get("tc_api_session")
    api_id, api_hash = get_api_credentials(sid)
    if not api_id or not api_hash:
        return JSONResponse(status_code=400, content={
            "status": "error",
            "message": "Telegram API credentials not configured. Please complete setup first.",
            "setup_url": "/setup",
        })

    ok, result = validate_phone_number(body.phone)
    if not ok:
        log_security_event(request, "INVALID_PHONE", f"Invalid phone: {body.phone}")
        return JSONResponse(status_code=400, content={"status": "error", "message": result})
    phone = result

    # If we already have a hash for this phone, skip the Telegram call
    if phone in phone_code_hashes:
        return {"status": "code_sent", "message": f"Code already sent to {phone}. Check your Telegram app."}

    async def _do_send(ph, aid, ahash):
        client = await get_client(ph, aid, ahash)
        r = await client.send_code_request(ph)
        return r.phone_code_hash

    try:
        pch = await _do_send(phone, api_id, api_hash)
        phone_code_hashes[phone] = pch
        log_security_event(request, "OTP_SENT", f"OTP sent to {phone}", phone)
        return {"status": "code_sent", "message": f"OTP sent to {phone}. Check your Telegram app."}
    except AuthRestartError:
        # Telegram auth key invalidated mid-request; discard stale client and retry once
        await remove_client(phone)
        try:
            pch = await _do_send(phone, api_id, api_hash)
            phone_code_hashes[phone] = pch
            log_security_event(request, "OTP_SENT", f"OTP sent to {phone} (retry)", phone)
            return {"status": "code_sent", "message": f"OTP sent to {phone}. Check your Telegram app."}
        except Exception as e2:
            logger.error(f"SEND CODE RETRY ERROR: {e2}")
            return JSONResponse(status_code=500, content={"status": "error", "message": "Telegram connection error. Please try again."})
    except Exception as e:
        logger.error(f"SEND CODE ERROR: {e}")
        if phone in phone_code_hashes:
            return {"status": "code_sent", "message": f"Code already sent to {phone}. Enter it below."}
        return JSONResponse(status_code=500, content={"status": "error", "message": "Failed to send OTP. Please wait a minute and try again."})


@router.post("/verify_code")
async def verify_code(request: Request, response: Response, body: VerifyCodeRequest):
    rl = await rate_limit_check(request)
    if rl:
        return rl
    check_csrf(request)

    ok, result = validate_phone_number(body.phone)
    if not ok:
        return JSONResponse(status_code=400, content={"status": "error", "message": result})
    phone = result
    code = sanitize_input(body.code)
    if not code:
        return JSONResponse(status_code=400, content={"status": "error", "message": "OTP code is required"})

    sid = request.cookies.get("tc_api_session")
    api_id, api_hash = get_api_credentials(sid)
    if not api_id or not api_hash:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing. Please setup again.", "setup_url": "/setup"})

    try:
        client = await get_client(phone, api_id, api_hash)
        pch = phone_code_hashes.get(phone)
        if not pch:
            return {"status": "failed", "error": "No code hash. Request OTP again."}
        await client.sign_in(phone=phone, code=code, phone_code_hash=pch)
        log_security_event(request, "LOGIN_SUCCESS", "Logged in", phone)
        set_auth_cookies(response, phone)
        return {"status": "success"}
    except SessionPasswordNeededError:
        log_security_event(request, "2FA_REQUIRED", "2FA required", phone)
        return {"status": "2fa_required"}
    except Exception as e:
        logger.error(f"VERIFY CODE ERROR: {e}")
        log_security_event(request, "LOGIN_FAILED", str(e), phone)
        return {"status": "failed", "error": "Invalid OTP or session expired"}


@router.post("/verify_password")
async def verify_password(request: Request, response: Response, body: VerifyPasswordRequest):
    rl = await rate_limit_check(request)
    if rl:
        return rl
    check_csrf(request)

    ok, result = validate_phone_number(body.phone)
    if not ok:
        return JSONResponse(status_code=400, content={"status": "error", "message": result})
    phone = result
    password = sanitize_input(body.password)
    if not password:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Password is required"})

    sid = request.cookies.get("tc_api_session")
    api_id, api_hash = get_api_credentials(sid)
    if not api_id or not api_hash:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing."})

    try:
        client = await get_client(phone, api_id, api_hash)
        if not await client.is_user_authorized():
            await client.sign_in(password=password)
        log_security_event(request, "2FA_SUCCESS", "2FA verified", phone)
        set_auth_cookies(response, phone)
        return {"status": "success"}
    except Exception as e:
        logger.error(f"VERIFY PASSWORD ERROR: {e}")
        log_security_event(request, "2FA_FAILED", str(e), phone)
        return {"status": "failed", "error": "Invalid password"}


# ── Me ────────────────────────────────────────────────────────────────────────

@router.get("/me")
async def me(phone: str = Depends(get_current_user)):
    return {"status": "success", "phone": phone}


# ── Logout ────────────────────────────────────────────────────────────────────

@router.post("/logout")
async def logout(request: Request, response: Response):
    rl = await rate_limit_check(request)
    if rl:
        return rl
    check_csrf(request)

    token = request.cookies.get("session_token")
    api_sid = request.cookies.get("tc_api_session")
    sess = get_session_data(token) if token else None
    phone = sess["phone"] if sess else None

    if token:
        destroy_session(token)
    if phone:
        await remove_client(phone)
        phone_code_hashes.pop(phone, None)
        cache_invalidate(phone)
        log_security_event(request, "LOGOUT", "User logged out", phone)

    if api_sid:
        delete_api_session(api_sid)

    response.delete_cookie("session_token", path="/")
    response.delete_cookie("csrf_token", path="/")
    response.delete_cookie("tc_api_session", path="/")
    return {"status": "success"}


# ── Delete all data ───────────────────────────────────────────────────────────

@router.post("/delete_data")
async def delete_data(
    request: Request,
    response: Response,
    phone: str = Depends(get_current_user),
):
    check_csrf(request)
    token = request.cookies.get("session_token")
    destroy_session(token)
    await remove_client(phone)
    phone_code_hashes.pop(phone, None)
    delete_all_folders(phone)
    cache_invalidate(phone)

    # remove thumbnails for this user
    import hashlib
    from backend.telegram_client import SESSIONS_FOLDER
    phone_hash = hashlib.sha256(phone.encode()).hexdigest()[:16]
    thumbs_dir = "thumbs"
    if os.path.isdir(thumbs_dir):
        for f in os.listdir(thumbs_dir):
            if f.startswith(phone_hash):
                os.remove(os.path.join(thumbs_dir, f))

    log_security_event(request, "DATA_DELETED", "All data deleted", phone)
    response.delete_cookie("session_token", path="/")
    response.delete_cookie("csrf_token", path="/")
    return {"status": "success", "message": "All data deleted"}
