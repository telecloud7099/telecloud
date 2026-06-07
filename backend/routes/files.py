import os
import uuid
import hashlib
import asyncio
import logging
import time as _time
from typing import AsyncIterator, Optional
from fastapi import APIRouter, Request, Depends, UploadFile, File, Form, Query
from fastapi.responses import JSONResponse, StreamingResponse, Response
from pydantic import BaseModel
from fastapi.concurrency import run_in_threadpool

from backend.auth import get_current_user, check_csrf
from backend.database import get_api_credentials, add_folder
from backend.telegram_client import get_client
from backend.cache import cache_get, cache_set, cache_invalidate
from backend.security import (
    rate_limit_check, validate_file_upload, sanitize_input, log_security_event,
)

router = APIRouter()
logger = logging.getLogger(__name__)

UPLOAD_FOLDER = "uploads"
THUMB_FOLDER = "thumbs"
PAGE_SIZE = 50
MAX_SCAN_MESSAGES = int(os.getenv("MAX_SCAN_MESSAGES", "2000") or "2000")

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(THUMB_FOLDER, exist_ok=True)


def _categorize(name: str, mime: str) -> str:
    name = (name or "").lower()
    mime = (mime or "").lower()
    if name.endswith(".apk") or mime == "application/vnd.android.package-archive":
        return "APK"
    if mime.startswith("image/"):
        return "Images"
    if mime.startswith("video/"):
        return "Videos"
    if mime.startswith("audio/"):
        return "Audio"
    if any(name.endswith(e) for e in (".pdf", ".txt", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx")) or "pdf" in mime:
        return "Docs"
    if any(name.endswith(e) for e in (".zip", ".rar", ".7z", ".tar", ".gz", ".tgz")):
        return "Archives"
    return "Other"


def _get_creds(request: Request):
    sid = request.cookies.get("tc_api_session")
    return get_api_credentials(sid)


# ── Cache-backed scan helpers ─────────────────────────────────────────────────

async def _full_scan(phone: str, api_id: int, api_hash: str) -> list[dict]:
    from backend.database import db_save_files, update_sync_state
    client = await get_client(phone, api_id, api_hash, require_authorized=True)
    max_scan = None if MAX_SCAN_MESSAGES == 0 else MAX_SCAN_MESSAGES
    files = []
    seen: set[int] = set()
    newest_id = 0
    async for msg in client.iter_messages("me", limit=max_scan):
        if not msg or not msg.file or msg.id in seen:
            continue
        seen.add(msg.id)
        if msg.id > newest_id:
            newest_id = msg.id
        name = msg.file.name or f"file_{msg.id}"
        mime = msg.file.mime_type or "application/octet-stream"
        files.append({
            "id": msg.id, "name": name,
            "size": msg.file.size or 0, "mime_type": mime,
            "date": msg.date.isoformat() if msg.date else None,
            "category": _categorize(name, mime),
            "caption": (msg.text or "").strip(),
        })
    files.sort(key=lambda x: x.get("date") or "", reverse=True)
    db_save_files(phone, files)
    update_sync_state(phone, last_sync_at=_time.time(), newest_msg_id=newest_id)
    return files


async def _incremental_sync(phone: str, api_id: int, api_hash: str, force: bool = False):
    from backend.database import (
        db_get_files, db_upsert_files, get_sync_state, update_sync_state
    )
    state = get_sync_state(phone)
    if not force and _time.time() - state["last_sync_at"] < 600:
        return 0
    try:
        client = await get_client(phone, api_id, api_hash, require_authorized=True)
        min_id = state["newest_msg_id"]
        new_files = []
        newest_id = min_id
        async for msg in client.iter_messages("me", min_id=min_id, limit=200):
            if not msg or not msg.file:
                continue
            if msg.id > newest_id:
                newest_id = msg.id
            name = msg.file.name or f"file_{msg.id}"
            mime = msg.file.mime_type or "application/octet-stream"
            new_files.append({
                "id": msg.id, "name": name,
                "size": msg.file.size or 0, "mime_type": mime,
                "date": msg.date.isoformat() if msg.date else None,
                "category": _categorize(name, mime),
                "caption": (msg.text or "").strip(),
            })
        if new_files:
            db_upsert_files(phone, new_files)
            all_files = db_get_files(phone)
            all_files.sort(key=lambda x: x.get("date") or "", reverse=True)
            cache_set(f"{phone}:all_files", all_files)
        update_sync_state(phone, last_sync_at=_time.time(), newest_msg_id=newest_id)
        return len(new_files)
    except Exception as e:
        logger.error(f"Incremental sync error for {phone}: {e}")
        return 0


# ── List all files ────────────────────────────────────────────────────────────

@router.get("/files")
async def list_all_files(
    request: Request,
    offset: int = Query(0),
    limit: int = Query(PAGE_SIZE),
    category: str = Query("All"),
    refresh: bool = Query(False),
    phone: str = Depends(get_current_user),
):
    rl = await rate_limit_check(request)
    if rl:
        return rl

    api_id, api_hash = _get_creds(request)
    if not api_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing"})

    cache_key = f"{phone}:all_files"
    if refresh:
        cache_invalidate(phone)

    all_files = cache_get(cache_key)

    if all_files is None:
        # Try DB first — instant load, no Telegram call
        from backend.database import db_get_files, get_sync_state
        db_files = db_get_files(phone)
        if db_files:
            all_files = sorted(db_files, key=lambda x: x.get("date") or "", reverse=True)
            cache_set(cache_key, all_files)
            # Kick off incremental sync in background (non-blocking)
            asyncio.create_task(_incremental_sync(phone, api_id, api_hash))
        else:
            # First ever use — must do full scan (blocks until done)
            all_files = await _full_scan(phone, api_id, api_hash)
            cache_set(cache_key, all_files)

    filtered = [f for f in all_files if f.get("category") == category] if category != "All" else all_files
    page = filtered[offset: offset + limit]

    log_security_event(request, "ALL_FILES_LISTED", f"offset={offset} cat={category}", phone)
    return {
        "status": "success",
        "files": page,
        "total": len(filtered),
        "has_more": offset + limit < len(filtered),
        "scan_limit": MAX_SCAN_MESSAGES,
        "scanned": len(all_files),
    }


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/files/stats")
async def files_stats(
    request: Request,
    phone: str = Depends(get_current_user),
):
    cache_key = f"{phone}:all_files"
    all_files = cache_get(cache_key)
    scanned = len(all_files) if all_files is not None else None
    has_more = (scanned == MAX_SCAN_MESSAGES) if scanned is not None else None
    return {
        "status": "success",
        "scan_limit": MAX_SCAN_MESSAGES,
        "scanned": scanned,
        "has_more": has_more,
        "cache_warm": all_files is not None,
    }


# ── Manual / auto sync ───────────────────────────────────────────────────────

@router.post("/files/sync")
async def sync_new_files(
    request: Request,
    phone: str = Depends(get_current_user),
):
    api_id, api_hash = _get_creds(request)
    if not api_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing"})
    new_count = await _incremental_sync(phone, api_id, api_hash, force=True)
    return {"status": "success", "new_files": new_count}


# ── Search ────────────────────────────────────────────────────────────────────

@router.get("/files/search")
async def search_files(
    request: Request,
    q: str = Query(""),
    phone: str = Depends(get_current_user),
):
    rl = await rate_limit_check(request)
    if rl:
        return rl

    query = q.strip().lower()
    if len(query) < 2:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Query must be at least 2 characters"})

    api_id, api_hash = _get_creds(request)
    if not api_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing"})

    cache_key = f"{phone}:all_files"
    all_files = cache_get(cache_key)

    if all_files is None:
        # warm the cache via the list endpoint logic
        client = await get_client(phone, api_id, api_hash, require_authorized=True)
        files = []
        seen: set[int] = set()
        max_scan = None if MAX_SCAN_MESSAGES == 0 else MAX_SCAN_MESSAGES
        async for msg in client.iter_messages("me", limit=max_scan):
            if not msg or not msg.file or msg.id in seen:
                continue
            seen.add(msg.id)
            name = msg.file.name or f"file_{msg.id}"
            mime = msg.file.mime_type or "application/octet-stream"
            files.append({
                "id": msg.id,
                "name": name,
                "size": msg.file.size or 0,
                "mime_type": mime,
                "date": msg.date.isoformat() if msg.date else None,
                "category": _categorize(name, mime),
                "caption": (msg.text or "").strip(),
            })
        files.sort(key=lambda x: x.get("date") or "", reverse=True)
        all_files = files
        cache_set(cache_key, all_files)

    results = [f for f in all_files if query in (f.get("name") or "").lower()]
    log_security_event(request, "FILES_SEARCHED", f"q={query} found={len(results)}", phone)
    return {"status": "success", "files": results[:200], "total": len(results), "query": query}


# ── Stream file with Range support ───────────────────────────────────────────

@router.get("/file/{msg_id}")
async def get_file(
    msg_id: int,
    request: Request,
    download: bool = Query(False),
    phone: str = Depends(get_current_user),
):
    api_id, api_hash = _get_creds(request)
    if not api_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing"})

    try:
        client = await get_client(phone, api_id, api_hash, require_authorized=True)
        message = await client.get_messages("me", ids=msg_id)
        if not message or not message.file:
            return JSONResponse(status_code=404, content={"status": "error", "message": "File not found"})

        mime = message.file.mime_type or "application/octet-stream"
        name = message.file.name or f"file_{msg_id}"
        file_size = message.file.size or 0

        # Disposition: inline for preview, attachment for download
        disposition = "attachment" if download else "inline"
        safe_name = name.replace('"', '_').replace('\r', '').replace('\n', '')

        # Handle Range requests for video/audio seeking
        range_header = request.headers.get("Range")
        if range_header and file_size:
            try:
                range_val = range_header.replace("bytes=", "")
                start_str, end_str = range_val.split("-")
                start = int(start_str)
                end = int(end_str) if end_str else file_size - 1
                end = min(end, file_size - 1)
                chunk_size = end - start + 1

                async def range_iter() -> AsyncIterator[bytes]:
                    async for chunk in client.iter_download(message.media, offset=start, limit=chunk_size):
                        yield chunk

                headers = {
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(chunk_size),
                    "Content-Disposition": f'{disposition}; filename="{safe_name}"',
                }
                return StreamingResponse(range_iter(), status_code=206, media_type=mime, headers=headers)
            except Exception as e:
                logger.warning(f"Range parse error: {e}, falling back to full stream")

        # Full file stream
        async def full_iter() -> AsyncIterator[bytes]:
            async for chunk in client.iter_download(message.media):
                yield chunk

        headers = {
            "Accept-Ranges": "bytes",
            "Content-Disposition": f'{disposition}; filename="{safe_name}"',
            "Cache-Control": "public, max-age=86400",
            "ETag": f'"{msg_id}"',
        }
        if file_size:
            headers["Content-Length"] = str(file_size)

        # ETag 304 check
        if request.headers.get("If-None-Match") == f'"{msg_id}"':
            return Response(status_code=304)

        return StreamingResponse(full_iter(), media_type=mime, headers=headers)

    except Exception as e:
        logger.error(f"GET FILE ERROR: {e}")
        return JSONResponse(status_code=404, content={"status": "error", "message": "File not found"})


# ── Thumbnail ─────────────────────────────────────────────────────────────────

@router.get("/thumbnail/{msg_id}")
async def get_thumbnail(
    msg_id: int,
    request: Request,
    phone: str = Depends(get_current_user),
):
    phone_hash = hashlib.sha256(phone.encode()).hexdigest()[:16]
    thumb_file = f"{phone_hash}_{msg_id}.jpg"
    thumb_path = os.path.join(os.path.abspath(THUMB_FOLDER), thumb_file)

    if os.path.exists(thumb_path):
        from fastapi.responses import FileResponse
        return FileResponse(thumb_path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=604800"})

    api_id, api_hash = _get_creds(request)
    if not api_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing"})

    try:
        client = await get_client(phone, api_id, api_hash, require_authorized=True)
        message = await client.get_messages("me", ids=msg_id)
        if not message or not message.file:
            return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})

        thumb_bytes = None

        if message.document and getattr(message.document, "thumbs", None):
            try:
                thumb_bytes = await message.download_media(bytes, thumb=0)
            except Exception:
                pass

        if not thumb_bytes and message.photo:
            try:
                thumb_bytes = await message.download_media(bytes, thumb=0)
            except Exception:
                pass

        if not thumb_bytes:
            mime = message.file.mime_type or ""
            if mime.startswith("image/") and message.file.size and message.file.size < 500_000:
                thumb_bytes = await message.download_media(bytes)

        if not thumb_bytes:
            return JSONResponse(status_code=404, content={"status": "error", "message": "No thumbnail"})

        with open(thumb_path, "wb") as f:
            f.write(thumb_bytes)

        return Response(
            content=thumb_bytes,
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=604800"},
        )
    except Exception as e:
        logger.error(f"GET THUMBNAIL ERROR: {e}")
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})


# ── Upload ────────────────────────────────────────────────────────────────────

@router.post("/upload")
async def upload(
    request: Request,
    folderName: str = Form(default=""),
    file: list[UploadFile] = File(...),
    phone: str = Depends(get_current_user),
):
    rl = await rate_limit_check(request)
    if rl:
        return rl
    check_csrf(request)

    api_id, api_hash = _get_creds(request)
    if not api_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing"})

    folder_name = sanitize_input(folderName)
    files = file

    if not files:
        return JSONResponse(status_code=400, content={"status": "error", "message": "No files provided"})

    for f in files:
        ok, result = validate_file_upload(f)
        if not ok:
            return JSONResponse(status_code=400, content={"status": "error", "message": result})

    # Save temp files
    saved: list[tuple[str, str]] = []
    for f in files:
        filename = f"{uuid.uuid4().hex}_{f.filename}"
        path = os.path.join(UPLOAD_FOLDER, filename)
        content = await f.read()
        with open(path, "wb") as fp:
            fp.write(content)
        saved.append((f.filename, path))

    uploaded: list[str] = []
    failed: list[str] = []

    try:
        client = await get_client(phone, api_id, api_hash, require_authorized=True)
        for orig_name, path in saved:
            try:
                await client.send_file("me", path, caption=folder_name or "", force_document=True)
                uploaded.append(orig_name)
            except Exception as e:
                logger.error(f"Error uploading {orig_name}: {e}")
                failed.append(orig_name)
            finally:
                if os.path.exists(path):
                    os.remove(path)
    except Exception as e:
        # Clean up any remaining temp files on total failure
        for _, path in saved:
            if os.path.exists(path):
                os.remove(path)
        logger.error(f"UPLOAD ERROR: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": "Upload failed"})

    if folder_name:
        add_folder(phone, folder_name)

    cache_invalidate(phone)
    from backend.database import db_clear_files
    db_clear_files(phone)
    log_security_event(request, "FILES_UPLOADED", f"uploaded={len(uploaded)} failed={len(failed)}", phone)

    if failed:
        return {
            "status": "partial",
            "uploaded": uploaded,
            "failed": failed,
            "message": f"{len(uploaded)} uploaded, {len(failed)} failed.",
        }
    return {"status": "success", "files": uploaded}


# ── Move files ────────────────────────────────────────────────────────────────

class MoveFilesBody(BaseModel):
    folder: str
    msg_ids: list[int]


@router.post("/files/move")
async def move_files(
    request: Request,
    body: MoveFilesBody,
    phone: str = Depends(get_current_user),
):
    rl = await rate_limit_check(request)
    if rl:
        return rl
    check_csrf(request)

    api_id, api_hash = _get_creds(request)
    if not api_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing"})

    folder = sanitize_input(body.folder).strip()
    if not folder:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Folder name is required"})
    if not body.msg_ids:
        return JSONResponse(status_code=400, content={"status": "error", "message": "msg_ids must be a non-empty list"})

    try:
        client = await get_client(phone, api_id, api_hash, require_authorized=True)

        async def edit_one(mid: int) -> Optional[int]:
            try:
                await client.edit_message("me", mid, folder)
                return None
            except Exception as e:
                logger.error(f"MOVE FILE ERROR msg_id={mid}: {e}")
                return mid

        results = await asyncio.gather(*[edit_one(mid) for mid in body.msg_ids])
        failed = [r for r in results if r is not None]
        moved = len(body.msg_ids) - len(failed)

        add_folder(phone, folder)
        cache_invalidate(phone)
        from backend.database import db_clear_files
        db_clear_files(phone)
        log_security_event(request, "FILES_MOVED", f"moved={moved} to={folder}", phone)
        return {"status": "success", "moved": moved, "failed": failed}
    except Exception as e:
        logger.error(f"MOVE FILES ERROR: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": "Failed to move files"})


# ── Delete files ──────────────────────────────────────────────────────────────

class DeleteFilesBody(BaseModel):
    msg_ids: list[int]


@router.delete("/files")
async def delete_files(
    request: Request,
    body: DeleteFilesBody,
    phone: str = Depends(get_current_user),
):
    rl = await rate_limit_check(request)
    if rl:
        return rl
    check_csrf(request)

    api_id, api_hash = _get_creds(request)
    if not api_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing"})

    if not body.msg_ids:
        return JSONResponse(status_code=400, content={"status": "error", "message": "msg_ids must be a non-empty list"})

    try:
        client = await get_client(phone, api_id, api_hash, require_authorized=True)
        deleted, failed = 0, []
        for i in range(0, len(body.msg_ids), 100):
            chunk = body.msg_ids[i: i + 100]
            try:
                await client.delete_messages("me", chunk)
                deleted += len(chunk)
            except Exception as e:
                logger.error(f"DELETE chunk error: {e}")
                failed.extend(chunk)

        # Remove cached thumbnails
        phone_hash = hashlib.sha256(phone.encode()).hexdigest()[:16]
        for mid in body.msg_ids:
            tp = os.path.join(THUMB_FOLDER, f"{phone_hash}_{mid}.jpg")
            if os.path.exists(tp):
                os.remove(tp)

        cache_invalidate(phone)
        from backend.database import db_clear_files
        db_clear_files(phone)
        log_security_event(request, "FILES_DELETED", f"deleted={deleted}", phone)
        return {"status": "success", "deleted": deleted, "failed": failed}
    except Exception as e:
        logger.error(f"DELETE FILES ERROR: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": "Failed to delete files"})
