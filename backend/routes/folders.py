import asyncio
import logging
from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend.auth import get_current_user, check_csrf
from backend.database import (
    get_api_credentials, get_folders, folder_exists,
    add_folder, rename_folder_db, delete_folder_db,
)
from backend.telegram_client import get_client
from backend.cache import cache_get, cache_set, cache_invalidate
from backend.security import rate_limit_check, sanitize_input, log_security_event

router = APIRouter()
logger = logging.getLogger(__name__)


def _get_creds(request: Request):
    sid = request.cookies.get("tc_api_session")
    return get_api_credentials(sid)


# ── List folders ──────────────────────────────────────────────────────────────

@router.get("/folders")
async def list_folders(
    request: Request,
    phone: str = Depends(get_current_user),
):
    folders = get_folders(phone)
    log_security_event(request, "FOLDERS_LISTED", f"count={len(folders)}", phone)
    return {"status": "success", "folders": folders}


# ── Folder counts + storage stats ────────────────────────────────────────────

@router.get("/folders/counts")
async def folder_counts(
    request: Request,
    phone: str = Depends(get_current_user),
):
    rl = await rate_limit_check(request)
    if rl:
        return rl

    cache_key = f"{phone}:folder_counts"
    cached = cache_get(cache_key)
    if cached is not None:
        return {"status": "success", **cached}

    folder_list = get_folders(phone)

    # Use all_files cache (now includes caption) — zero extra Telegram calls
    all_files = cache_get(f"{phone}:all_files")
    if all_files is not None:
        counts = {f: 0 for f in folder_list}
        total_size = sum(f.get("size", 0) for f in all_files)
        for f in all_files:
            cap = f.get("caption", "")
            if cap and cap in counts:
                counts[cap] += 1
        result = {"counts": counts, "total_files": len(all_files), "total_size": total_size}
        cache_set(cache_key, result)
        return {"status": "success", **result}

    # Cache cold — do a targeted Telegram scan
    api_id, api_hash = _get_creds(request)
    if not api_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing"})

    try:
        client = await get_client(phone, api_id, api_hash, require_authorized=True)
        counts = {f: 0 for f in folder_list}
        total_size = 0
        total_files = 0
        async for msg in client.iter_messages("me", limit=500):
            if not msg or not msg.file:
                continue
            total_files += 1
            total_size += msg.file.size or 0
            if msg.text:
                caption = msg.text.strip()
                if caption in counts:
                    counts[caption] += 1
        result = {"counts": counts, "total_files": total_files, "total_size": total_size}
        cache_set(cache_key, result)
        return {"status": "success", **result}
    except Exception as e:
        logger.error(f"FOLDER COUNTS ERROR: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": "Failed to get counts"})


# ── Create folder ─────────────────────────────────────────────────────────────

class CreateFolderBody(BaseModel):
    folder_name: str


@router.post("/folders")
async def create_folder(
    request: Request,
    body: CreateFolderBody,
    phone: str = Depends(get_current_user),
):
    check_csrf(request)
    name = sanitize_input(body.folder_name).strip()
    if not name:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Folder name is required"})
    if folder_exists(phone, name):
        return JSONResponse(status_code=400, content={"status": "error", "message": "Folder already exists"})
    add_folder(phone, name)
    log_security_event(request, "FOLDER_CREATED", f"name={name}", phone)
    return {"status": "success", "folder": name}


# ── Rename folder ─────────────────────────────────────────────────────────────

class RenameFolderBody(BaseModel):
    new_name: str


@router.put("/folders/{old_name}")
async def rename_folder(
    old_name: str,
    request: Request,
    body: RenameFolderBody,
    phone: str = Depends(get_current_user),
):
    rl = await rate_limit_check(request)
    if rl:
        return rl
    check_csrf(request)

    old_name = sanitize_input(old_name).strip()
    new_name = sanitize_input(body.new_name).strip()

    if not old_name or not new_name:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Both names are required"})
    if old_name == new_name:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Names are the same"})
    if not folder_exists(phone, old_name):
        return JSONResponse(status_code=404, content={"status": "error", "message": "Folder not found"})
    if folder_exists(phone, new_name):
        return JSONResponse(status_code=400, content={"status": "error", "message": "A folder with that name already exists"})

    api_id, api_hash = _get_creds(request)
    if not api_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing"})

    try:
        client = await get_client(phone, api_id, api_hash, require_authorized=True)
        messages = await client.get_messages("me", limit=500)

        # Parallel edits with asyncio.gather
        targets = [msg for msg in messages if msg.file and msg.text and msg.text.strip() == old_name]

        async def edit_one(msg) -> bool:
            try:
                await client.edit_message("me", msg.id, new_name)
                return True
            except Exception as e:
                logger.error(f"RENAME caption error msg={msg.id}: {e}")
                return False

        results = await asyncio.gather(*[edit_one(m) for m in targets])
        renamed = sum(1 for r in results if r)

        rename_folder_db(phone, old_name, new_name)
        cache_invalidate(phone)
        log_security_event(request, "FOLDER_RENAMED", f"{old_name}→{new_name} files={renamed}", phone)
        return {"status": "success", "renamed_files": renamed}
    except Exception as e:
        logger.error(f"RENAME FOLDER ERROR: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": "Failed to rename folder"})


# ── Delete folder ─────────────────────────────────────────────────────────────

@router.delete("/folders/{folder_name}")
async def delete_folder(
    folder_name: str,
    request: Request,
    phone: str = Depends(get_current_user),
):
    check_csrf(request)
    name = sanitize_input(folder_name).strip()
    if not folder_exists(phone, name):
        return JSONResponse(status_code=404, content={"status": "error", "message": "Folder not found"})
    delete_folder_db(phone, name)
    cache_invalidate(phone)
    log_security_event(request, "FOLDER_DELETED", f"name={name}", phone)
    return {"status": "success", "message": "Folder removed. Files are still in Telegram."}


# ── Files in folder ───────────────────────────────────────────────────────────

@router.get("/folders/{folder_name}/files")
async def list_files_in_folder(
    folder_name: str,
    request: Request,
    phone: str = Depends(get_current_user),
):
    rl = await rate_limit_check(request)
    if rl:
        return rl

    folder = sanitize_input(folder_name).strip()
    if not folder:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Folder name is required"})

    cache_key = f"{phone}:folder:{folder}"
    cached = cache_get(cache_key)
    if cached is not None:
        return {"status": "success", "files": cached, "total": len(cached)}

    # Use all_files cache (now has caption field) — zero extra Telegram calls
    all_files = cache_get(f"{phone}:all_files")
    if all_files is not None:
        files = [
            {k: v for k, v in f.items() if k != "caption"}
            for f in all_files
            if f.get("caption") == folder
        ]
        cache_set(cache_key, files)
        log_security_event(request, "FILES_LISTED", f"folder={folder} count={len(files)} (from cache)", phone)
        return {"status": "success", "files": files, "total": len(files)}

    # Cache cold — targeted Telegram scan
    api_id, api_hash = _get_creds(request)
    if not api_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "API credentials missing"})

    try:
        client = await get_client(phone, api_id, api_hash, require_authorized=True)
        messages = await client.get_messages("me", limit=1000)
        files = []
        for msg in messages:
            if msg.file and msg.text and msg.text.strip() == folder:
                files.append({
                    "id": msg.id,
                    "name": msg.file.name or f"file_{msg.id}",
                    "size": msg.file.size or 0,
                    "mime_type": msg.file.mime_type or "application/octet-stream",
                    "date": msg.date.isoformat() if msg.date else None,
                })
        cache_set(cache_key, files)
        log_security_event(request, "FILES_LISTED", f"folder={folder} count={len(files)}", phone)
        return {"status": "success", "files": files, "total": len(files)}
    except Exception as e:
        logger.error(f"LIST FILES IN FOLDER ERROR: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": "Failed to list files"})
