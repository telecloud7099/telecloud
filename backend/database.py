import os
import json
import hashlib
import logging
from datetime import datetime
from typing import Optional
from sqlmodel import Field, Session, SQLModel, create_engine, select
from cryptography.fernet import Fernet
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///telecloud.db")
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})

SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise ValueError("No SECRET_KEY set")
cipher = Fernet(SECRET_KEY.encode())


# ── Models ────────────────────────────────────────────────────────────────────

class ApiSession(SQLModel, table=True):
    id: str = Field(primary_key=True)
    api_id: int
    api_hash_encrypted: str
    created_at: float = Field(default_factory=lambda: datetime.utcnow().timestamp())
    ip: Optional[str] = None
    ua: Optional[str] = None


class UserFolder(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    phone_hash: str = Field(index=True)
    name: str


class CachedFile(SQLModel, table=True):
    pk: str = Field(primary_key=True)           # f"{phone_hash}:{msg_id}"
    phone_hash: str = Field(index=True)
    msg_id: int
    name: str
    size: int = Field(default=0)
    mime_type: str = Field(default="application/octet-stream")
    date: Optional[str] = Field(default=None)
    category: str = Field(default="Other")
    caption: str = Field(default="")


class SyncState(SQLModel, table=True):
    phone_hash: str = Field(primary_key=True)
    last_sync_at: float = Field(default=0.0)
    newest_msg_id: int = Field(default=0)


class AppSession(SQLModel, table=True):
    token: str = Field(primary_key=True)
    phone: str
    created_at: float
    last_active: float


# ── Init ──────────────────────────────────────────────────────────────────────

def init_db():
    SQLModel.metadata.create_all(engine)
    _migrate_json_files()


def get_session():
    with Session(engine) as session:
        yield session


# ── ApiSession helpers ────────────────────────────────────────────────────────

def get_api_credentials(sid: str) -> tuple[Optional[int], Optional[str]]:
    if not sid:
        return None, None
    with Session(engine) as s:
        row = s.get(ApiSession, sid)
        if not row:
            return None, None
        try:
            api_hash = cipher.decrypt(row.api_hash_encrypted.encode()).decode()
            return row.api_id, api_hash
        except Exception:
            return None, None


def save_api_session(sid: str, api_id: int, api_hash: str, ip: str, ua: str):
    encrypted = cipher.encrypt(api_hash.encode()).decode()
    with Session(engine) as s:
        existing = s.get(ApiSession, sid)
        if existing:
            existing.api_id = api_id
            existing.api_hash_encrypted = encrypted
            existing.ip = ip
            existing.ua = ua
            existing.created_at = datetime.utcnow().timestamp()
            s.add(existing)
        else:
            s.add(ApiSession(id=sid, api_id=api_id, api_hash_encrypted=encrypted, ip=ip, ua=ua))
        s.commit()


def delete_api_session(sid: str):
    if not sid:
        return
    with Session(engine) as s:
        row = s.get(ApiSession, sid)
        if row:
            s.delete(row)
            s.commit()


def purge_expired_api_sessions(ttl_seconds: int = 604800):
    cutoff = datetime.utcnow().timestamp() - ttl_seconds
    with Session(engine) as s:
        expired = s.exec(
            select(ApiSession).where(ApiSession.created_at < cutoff)
        ).all()
        for row in expired:
            s.delete(row)
        s.commit()


# ── UserFolder helpers ────────────────────────────────────────────────────────

def _phone_to_hash(phone: str) -> str:
    return hashlib.sha256(phone.encode()).hexdigest()


def get_folders(phone: str) -> list[str]:
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        rows = s.exec(select(UserFolder).where(UserFolder.phone_hash == ph)).all()
        return sorted(r.name for r in rows)


def folder_exists(phone: str, name: str) -> bool:
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        row = s.exec(
            select(UserFolder).where(
                UserFolder.phone_hash == ph,
                UserFolder.name == name
            )
        ).first()
        return row is not None


def add_folder(phone: str, name: str):
    if folder_exists(phone, name):
        return
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        s.add(UserFolder(phone_hash=ph, name=name))
        s.commit()


def rename_folder_db(phone: str, old_name: str, new_name: str):
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        row = s.exec(
            select(UserFolder).where(
                UserFolder.phone_hash == ph,
                UserFolder.name == old_name
            )
        ).first()
        if row:
            row.name = new_name
            s.add(row)
            s.commit()


def delete_folder_db(phone: str, name: str):
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        row = s.exec(
            select(UserFolder).where(
                UserFolder.phone_hash == ph,
                UserFolder.name == name
            )
        ).first()
        if row:
            s.delete(row)
            s.commit()


def delete_all_folders(phone: str):
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        rows = s.exec(select(UserFolder).where(UserFolder.phone_hash == ph)).all()
        for row in rows:
            s.delete(row)
        s.commit()


# ── AppSession helpers ────────────────────────────────────────────────────────

def load_all_sessions() -> dict:
    with Session(engine) as s:
        rows = s.exec(select(AppSession)).all()
        return {r.token: {"phone": r.phone, "created_at": r.created_at, "last_active": r.last_active} for r in rows}


def persist_session(token: str, phone: str, created_at: float, last_active: float):
    with Session(engine) as s:
        s.merge(AppSession(token=token, phone=phone, created_at=created_at, last_active=last_active))
        s.commit()


def remove_session(token: str):
    with Session(engine) as s:
        row = s.get(AppSession, token)
        if row:
            s.delete(row)
            s.commit()


def remove_sessions_for_phone(phone: str):
    with Session(engine) as s:
        rows = s.exec(select(AppSession).where(AppSession.phone == phone)).all()
        for row in rows:
            s.delete(row)
        s.commit()


# ── CachedFile helpers ────────────────────────────────────────────────────────

def db_get_files(phone: str) -> list[dict]:
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        rows = s.exec(select(CachedFile).where(CachedFile.phone_hash == ph)).all()
        return [
            {"id": r.msg_id, "name": r.name, "size": r.size,
             "mime_type": r.mime_type, "date": r.date,
             "category": r.category, "caption": r.caption}
            for r in rows
        ]


def db_save_files(phone: str, files: list[dict]):
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        existing = s.exec(select(CachedFile).where(CachedFile.phone_hash == ph)).all()
        for row in existing:
            s.delete(row)
        for f in files:
            s.add(CachedFile(
                pk=f"{ph}:{f['id']}", phone_hash=ph, msg_id=f["id"],
                name=f["name"], size=f.get("size", 0),
                mime_type=f.get("mime_type", "application/octet-stream"),
                date=f.get("date"), category=f.get("category", "Other"),
                caption=f.get("caption", ""),
            ))
        s.commit()


def db_upsert_files(phone: str, files: list[dict]):
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        for f in files:
            pk = f"{ph}:{f['id']}"
            row = s.get(CachedFile, pk)
            if row:
                row.name = f["name"]; row.size = f.get("size", 0)
                row.mime_type = f.get("mime_type", "application/octet-stream")
                row.date = f.get("date"); row.category = f.get("category", "Other")
                row.caption = f.get("caption", "")
                s.add(row)
            else:
                s.add(CachedFile(
                    pk=pk, phone_hash=ph, msg_id=f["id"],
                    name=f["name"], size=f.get("size", 0),
                    mime_type=f.get("mime_type", "application/octet-stream"),
                    date=f.get("date"), category=f.get("category", "Other"),
                    caption=f.get("caption", ""),
                ))
        s.commit()


def db_delete_files_by_ids(phone: str, msg_ids: list[int]):
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        for mid in msg_ids:
            row = s.get(CachedFile, f"{ph}:{mid}")
            if row:
                s.delete(row)
        s.commit()


def db_clear_files(phone: str):
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        rows = s.exec(select(CachedFile).where(CachedFile.phone_hash == ph)).all()
        for row in rows:
            s.delete(row)
        s.commit()


def get_sync_state(phone: str) -> dict:
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        row = s.get(SyncState, ph)
        if row:
            return {"last_sync_at": row.last_sync_at, "newest_msg_id": row.newest_msg_id}
        return {"last_sync_at": 0.0, "newest_msg_id": 0}


def update_sync_state(phone: str, last_sync_at: float = None, newest_msg_id: int = None):
    ph = _phone_to_hash(phone)
    with Session(engine) as s:
        row = s.get(SyncState, ph)
        if not row:
            row = SyncState(phone_hash=ph)
        if last_sync_at is not None:
            row.last_sync_at = last_sync_at
        if newest_msg_id is not None and newest_msg_id > row.newest_msg_id:
            row.newest_msg_id = newest_msg_id
        s.merge(row)
        s.commit()


# ── JSON migration (runs once on startup if JSON files exist) ─────────────────

def _migrate_json_files():
    _migrate_api_sessions()
    _migrate_user_folders()


def _migrate_api_sessions():
    path = "api_sessions.json"
    if not os.path.exists(path):
        return
    try:
        # Try encrypted first, then plaintext fallback
        try:
            with open(path, "rb") as f:
                data = json.loads(cipher.decrypt(f.read()))
        except Exception:
            with open(path, "r") as f:
                data = json.load(f)

        with Session(engine) as s:
            for sid, entry in data.items():
                if s.get(ApiSession, sid):
                    continue
                try:
                    api_hash = str(entry.get("api_hash", ""))
                    encrypted = cipher.encrypt(api_hash.encode()).decode()
                    s.add(ApiSession(
                        id=sid,
                        api_id=int(entry["api_id"]),
                        api_hash_encrypted=encrypted,
                        created_at=float(entry.get("created_at", 0)),
                        ip=entry.get("ip"),
                        ua=entry.get("ua"),
                    ))
                except Exception as e:
                    logger.warning(f"Skipping api_session {sid}: {e}")
            s.commit()

        os.rename(path, path + ".migrated")
        logger.info("Migrated api_sessions.json → SQLite")
    except Exception as e:
        logger.error(f"api_sessions migration failed: {e}")


def _migrate_user_folders():
    path = "user_folders.json"
    if not os.path.exists(path):
        return
    try:
        try:
            with open(path, "rb") as f:
                data = json.loads(cipher.decrypt(f.read()))
        except Exception:
            with open(path, "r") as f:
                data = json.load(f)

        with Session(engine) as s:
            for phone, folders in data.items():
                ph = _phone_to_hash(phone)
                for name in folders:
                    exists = s.exec(
                        select(UserFolder).where(
                            UserFolder.phone_hash == ph,
                            UserFolder.name == name
                        )
                    ).first()
                    if not exists:
                        s.add(UserFolder(phone_hash=ph, name=name))
            s.commit()

        os.rename(path, path + ".migrated")
        logger.info("Migrated user_folders.json → SQLite")
    except Exception as e:
        logger.error(f"user_folders migration failed: {e}")
