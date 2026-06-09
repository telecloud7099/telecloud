import os
import uuid
import hashlib
import logging
from datetime import datetime
from typing import Optional
from uuid import UUID, uuid4

from sqlmodel import Field, Session, SQLModel, create_engine, select
from sqlalchemy import BigInteger, Column, UniqueConstraint, Index
from cryptography.fernet import Fernet
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

_raw_url = os.getenv("DATABASE_URL", "")
if not _raw_url:
    raise ValueError("DATABASE_URL environment variable is required")
# Neon and some providers emit postgres:// — SQLAlchemy requires postgresql://
DATABASE_URL = _raw_url.replace("postgres://", "postgresql://", 1) if _raw_url.startswith("postgres://") else _raw_url

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,   # Detect stale connections before use (fixes post-restart 500 errors)
    pool_recycle=300,     # Recycle connections after 5 minutes
)

ENCRYPTION_KEY = os.getenv("ENCRYPTION_KEY") or os.getenv("SECRET_KEY")
if not ENCRYPTION_KEY:
    raise ValueError("ENCRYPTION_KEY (or SECRET_KEY) environment variable is required")
_cipher = Fernet(ENCRYPTION_KEY.encode())


def encrypt(value: str) -> str:
    return _cipher.encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    return _cipher.decrypt(value.encode()).decode()


def phone_to_hash(phone: str) -> str:
    return hashlib.sha256(phone.encode()).hexdigest()


# ── Models ────────────────────────────────────────────────────────────────────

class User(SQLModel, table=True):
    __tablename__ = "users"
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    telegram_user_id: int = Field(sa_column=Column("telegram_user_id", BigInteger(), unique=True, nullable=False, index=True))
    username: Optional[str] = Field(default=None)
    first_name: Optional[str] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class UserApiCredentials(SQLModel, table=True):
    __tablename__ = "user_api_credentials"
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    telegram_user_id: int = Field(sa_column=Column("telegram_user_id", BigInteger(), unique=True, nullable=False, index=True))
    phone_hash: str = Field(index=True)
    api_id_encrypted: str
    api_hash_encrypted: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class UserTelegramSession(SQLModel, table=True):
    __tablename__ = "user_sessions"
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    telegram_user_id: int = Field(sa_column=Column("telegram_user_id", BigInteger(), unique=True, nullable=False, index=True))
    string_session_encrypted: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class Folder(SQLModel, table=True):
    __tablename__ = "folders"
    __table_args__ = (UniqueConstraint("telegram_user_id", "name", name="uq_folders_user_name"),)
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    telegram_user_id: int = Field(sa_column=Column("telegram_user_id", BigInteger(), nullable=False, index=True))
    name: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class TelegramFile(SQLModel, table=True):
    __tablename__ = "files"
    __table_args__ = (UniqueConstraint("telegram_user_id", "telegram_message_id", name="uq_files_user_msg"),)
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    telegram_user_id: int = Field(sa_column=Column("telegram_user_id", BigInteger(), nullable=False, index=True))
    folder_id: Optional[UUID] = Field(default=None, foreign_key="folders.id")
    telegram_message_id: int = Field(sa_column=Column("telegram_message_id", BigInteger(), nullable=False, index=True))
    filename: str
    mime_type: str = Field(default="application/octet-stream")
    file_size: int = Field(sa_column=Column("file_size", BigInteger(), nullable=False, server_default="0"))
    category: str = Field(default="Other")
    uploaded_at: Optional[datetime] = Field(default=None)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class SyncState(SQLModel, table=True):
    __tablename__ = "sync_state"
    telegram_user_id: int = Field(sa_column=Column("telegram_user_id", BigInteger(), primary_key=True))
    last_sync_at: Optional[datetime] = Field(default=None)
    newest_msg_id: int = Field(default=0, sa_column=Column("newest_msg_id", BigInteger(), nullable=False, server_default="0"))


class UserSettings(SQLModel, table=True):
    __tablename__ = "user_settings"
    telegram_user_id: int = Field(sa_column=Column("telegram_user_id", BigInteger(), primary_key=True))
    theme: str = Field(default="dark")
    default_upload_folder: Optional[str] = Field(default=None)
    max_scan_messages: int = Field(default=2000)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


# ── Init ──────────────────────────────────────────────────────────────────────

def init_db():
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session


# ── User helpers ──────────────────────────────────────────────────────────────

def get_or_create_user(telegram_user_id: int, username: Optional[str], first_name: Optional[str]) -> User:
    with Session(engine) as s:
        row = s.exec(select(User).where(User.telegram_user_id == telegram_user_id)).first()
        if row:
            row.username = username
            row.first_name = first_name
            row.updated_at = datetime.utcnow()
            s.add(row)
            s.commit()
            s.refresh(row)
            return row
        user = User(telegram_user_id=telegram_user_id, username=username, first_name=first_name)
        s.add(user)
        s.commit()
        s.refresh(user)
        return user


def get_user(telegram_user_id: int) -> Optional[User]:
    with Session(engine) as s:
        return s.exec(select(User).where(User.telegram_user_id == telegram_user_id)).first()


# ── In-memory credential caches (avoids repeated DB round-trips per Telegram call) ──
_cred_cache: dict[int, tuple[int, str]] = {}   # user_id → (api_id, api_hash)
_session_cache: dict[int, str | None] = {}     # user_id → string_session (None = no session)


# ── API credentials helpers ───────────────────────────────────────────────────

def save_api_credentials(telegram_user_id: int, phone: str, api_id: int, api_hash: str):
    ph = phone_to_hash(phone)
    with Session(engine) as s:
        row = s.exec(select(UserApiCredentials).where(UserApiCredentials.telegram_user_id == telegram_user_id)).first()
        if row:
            row.phone_hash = ph
            row.api_id_encrypted = encrypt(str(api_id))
            row.api_hash_encrypted = encrypt(api_hash)
            row.updated_at = datetime.utcnow()
            s.add(row)
        else:
            s.add(UserApiCredentials(
                telegram_user_id=telegram_user_id,
                phone_hash=ph,
                api_id_encrypted=encrypt(str(api_id)),
                api_hash_encrypted=encrypt(api_hash),
            ))
        s.commit()
    _cred_cache[telegram_user_id] = (api_id, api_hash)


def get_api_credentials(telegram_user_id: int) -> tuple[Optional[int], Optional[str]]:
    if telegram_user_id in _cred_cache:
        return _cred_cache[telegram_user_id]
    with Session(engine) as s:
        row = s.exec(select(UserApiCredentials).where(UserApiCredentials.telegram_user_id == telegram_user_id)).first()
        if not row:
            return None, None
        try:
            result = int(decrypt(row.api_id_encrypted)), decrypt(row.api_hash_encrypted)
            _cred_cache[telegram_user_id] = result
            return result
        except Exception:
            return None, None


def credentials_exist_for_phone(phone: str) -> bool:
    ph = phone_to_hash(phone)
    with Session(engine) as s:
        row = s.exec(select(UserApiCredentials).where(UserApiCredentials.phone_hash == ph)).first()
        return row is not None


def get_api_credentials_by_phone(phone: str) -> tuple[Optional[int], Optional[str]]:
    ph = phone_to_hash(phone)
    with Session(engine) as s:
        row = s.exec(select(UserApiCredentials).where(UserApiCredentials.phone_hash == ph)).first()
        if not row:
            return None, None
        try:
            return int(decrypt(row.api_id_encrypted)), decrypt(row.api_hash_encrypted)
        except Exception:
            return None, None


# ── StringSession helpers ────────────────────────────────────────────────────

def save_string_session(telegram_user_id: int, string_session: str):
    _session_cache[telegram_user_id] = string_session
    with Session(engine) as s:
        row = s.exec(select(UserTelegramSession).where(UserTelegramSession.telegram_user_id == telegram_user_id)).first()
        if row:
            row.string_session_encrypted = encrypt(string_session)
            row.updated_at = datetime.utcnow()
            s.add(row)
        else:
            s.add(UserTelegramSession(
                telegram_user_id=telegram_user_id,
                string_session_encrypted=encrypt(string_session),
            ))
        s.commit()


def load_string_session(telegram_user_id: int) -> Optional[str]:
    if telegram_user_id in _session_cache:
        return _session_cache[telegram_user_id]
    with Session(engine) as s:
        row = s.exec(select(UserTelegramSession).where(UserTelegramSession.telegram_user_id == telegram_user_id)).first()
        if not row:
            _session_cache[telegram_user_id] = None
            return None
        try:
            result = decrypt(row.string_session_encrypted)
            _session_cache[telegram_user_id] = result
            return result
        except Exception:
            return None


# ── Folder helpers ────────────────────────────────────────────────────────────

def get_folders(telegram_user_id: int) -> list[dict]:
    with Session(engine) as s:
        rows = s.exec(select(Folder).where(Folder.telegram_user_id == telegram_user_id).order_by(Folder.name)).all()
        return [{"id": str(r.id), "name": r.name} for r in rows]


def get_folder_by_name(telegram_user_id: int, name: str) -> Optional[Folder]:
    with Session(engine) as s:
        return s.exec(select(Folder).where(
            Folder.telegram_user_id == telegram_user_id,
            Folder.name == name,
        )).first()


def get_folder_by_id(folder_id: UUID) -> Optional[Folder]:
    with Session(engine) as s:
        return s.get(Folder, folder_id)


def folder_exists(telegram_user_id: int, name: str) -> bool:
    return get_folder_by_name(telegram_user_id, name) is not None


def add_folder(telegram_user_id: int, name: str) -> Folder:
    existing = get_folder_by_name(telegram_user_id, name)
    if existing:
        return existing
    with Session(engine) as s:
        folder = Folder(telegram_user_id=telegram_user_id, name=name)
        s.add(folder)
        s.commit()
        s.refresh(folder)
        return folder


def rename_folder_db(telegram_user_id: int, old_name: str, new_name: str):
    with Session(engine) as s:
        row = s.exec(select(Folder).where(
            Folder.telegram_user_id == telegram_user_id,
            Folder.name == old_name,
        )).first()
        if row:
            row.name = new_name
            row.updated_at = datetime.utcnow()
            s.add(row)
            s.commit()


def delete_folder_db(telegram_user_id: int, name: str):
    with Session(engine) as s:
        row = s.exec(select(Folder).where(
            Folder.telegram_user_id == telegram_user_id,
            Folder.name == name,
        )).first()
        if row:
            # Unassign files in this folder
            files = s.exec(select(TelegramFile).where(TelegramFile.folder_id == row.id)).all()
            for f in files:
                f.folder_id = None
                s.add(f)
            s.delete(row)
            s.commit()


def delete_all_folders(telegram_user_id: int):
    with Session(engine) as s:
        rows = s.exec(select(Folder).where(Folder.telegram_user_id == telegram_user_id)).all()
        for row in rows:
            s.delete(row)
        s.commit()


# ── File helpers ──────────────────────────────────────────────────────────────

def _file_to_dict(f: TelegramFile, folder_name: Optional[str] = None) -> dict:
    return {
        "id": f.telegram_message_id,
        "name": f.filename,
        "size": f.file_size,
        "mime_type": f.mime_type,
        "date": f.uploaded_at.isoformat() if f.uploaded_at else None,
        "category": f.category,
        "folder_id": str(f.folder_id) if f.folder_id else None,
        "folder_name": folder_name,
    }


def db_get_files(telegram_user_id: int) -> list[dict]:
    with Session(engine) as s:
        # Single LEFT JOIN eliminates a full Neon round-trip vs two separate queries
        stmt = (
            select(TelegramFile, Folder.name.label("folder_name"))
            .outerjoin(Folder, TelegramFile.folder_id == Folder.id)
            .where(TelegramFile.telegram_user_id == telegram_user_id)
            .order_by(TelegramFile.uploaded_at.desc())
        )
        rows = s.exec(stmt).all()
        return [_file_to_dict(f, folder_name) for f, folder_name in rows]


def db_upsert_files(telegram_user_id: int, files: list[dict]):
    with Session(engine) as s:
        for f in files:
            existing = s.exec(select(TelegramFile).where(
                TelegramFile.telegram_user_id == telegram_user_id,
                TelegramFile.telegram_message_id == f["id"],
            )).first()

            folder_id: Optional[UUID] = None
            caption = f.get("caption", "").strip()
            if caption:
                folder = s.exec(select(Folder).where(
                    Folder.telegram_user_id == telegram_user_id,
                    Folder.name == caption,
                )).first()
                if folder:
                    folder_id = folder.id
                else:
                    new_folder = Folder(telegram_user_id=telegram_user_id, name=caption)
                    s.add(new_folder)
                    s.flush()
                    folder_id = new_folder.id

            uploaded_at = None
            if f.get("date"):
                try:
                    uploaded_at = datetime.fromisoformat(f["date"].replace("Z", "+00:00"))
                except Exception:
                    pass

            if existing:
                existing.filename = f["name"]
                existing.file_size = f.get("size", 0)
                existing.mime_type = f.get("mime_type", "application/octet-stream")
                existing.category = f.get("category", "Other")
                existing.uploaded_at = uploaded_at
                existing.updated_at = datetime.utcnow()
                if folder_id is not None:
                    existing.folder_id = folder_id
                s.add(existing)
            else:
                s.add(TelegramFile(
                    telegram_user_id=telegram_user_id,
                    telegram_message_id=f["id"],
                    folder_id=folder_id,
                    filename=f["name"],
                    mime_type=f.get("mime_type", "application/octet-stream"),
                    file_size=f.get("size", 0),
                    category=f.get("category", "Other"),
                    uploaded_at=uploaded_at,
                ))
        s.commit()


def db_insert_file(telegram_user_id: int, msg_id: int, filename: str,
                   mime_type: str, file_size: int, category: str,
                   uploaded_at: Optional[datetime], folder_id: Optional[UUID]):
    with Session(engine) as s:
        existing = s.exec(select(TelegramFile).where(
            TelegramFile.telegram_user_id == telegram_user_id,
            TelegramFile.telegram_message_id == msg_id,
        )).first()
        if existing:
            return
        s.add(TelegramFile(
            telegram_user_id=telegram_user_id,
            telegram_message_id=msg_id,
            folder_id=folder_id,
            filename=filename,
            mime_type=mime_type,
            file_size=file_size,
            category=category,
            uploaded_at=uploaded_at,
        ))
        s.commit()


def db_delete_files_by_ids(telegram_user_id: int, msg_ids: list[int]):
    with Session(engine) as s:
        rows = s.exec(select(TelegramFile).where(
            TelegramFile.telegram_user_id == telegram_user_id,
            TelegramFile.telegram_message_id.in_(msg_ids),
        )).all()
        for row in rows:
            s.delete(row)
        s.commit()


def db_move_files(telegram_user_id: int, msg_ids: list[int], folder_id: Optional[UUID]):
    with Session(engine) as s:
        rows = s.exec(select(TelegramFile).where(
            TelegramFile.telegram_user_id == telegram_user_id,
            TelegramFile.telegram_message_id.in_(msg_ids),
        )).all()
        for row in rows:
            row.folder_id = folder_id
            row.updated_at = datetime.utcnow()
            s.add(row)
        s.commit()


def db_get_files_in_folder(telegram_user_id: int, folder_id: UUID) -> list[dict]:
    with Session(engine) as s:
        folder = s.get(Folder, folder_id)
        folder_name = folder.name if folder else None
        rows = s.exec(select(TelegramFile).where(
            TelegramFile.telegram_user_id == telegram_user_id,
            TelegramFile.folder_id == folder_id,
        ).order_by(TelegramFile.uploaded_at.desc())).all()
        return [_file_to_dict(r, folder_name) for r in rows]


def db_get_folder_counts(telegram_user_id: int) -> dict:
    with Session(engine) as s:
        folders = s.exec(select(Folder).where(Folder.telegram_user_id == telegram_user_id)).all()
        all_files = s.exec(select(TelegramFile).where(TelegramFile.telegram_user_id == telegram_user_id)).all()
        total_files = len(all_files)
        total_size = sum(f.file_size for f in all_files)
        # Build lookup in Python — avoids N individual DB queries
        folder_id_to_name: dict[UUID, str] = {f.id: f.name for f in folders}
        counts: dict[str, int] = {f.name: 0 for f in folders}
        for file in all_files:
            if file.folder_id and file.folder_id in folder_id_to_name:
                counts[folder_id_to_name[file.folder_id]] += 1
        return {"counts": counts, "total_files": total_files, "total_size": total_size}


# ── Sync state helpers ────────────────────────────────────────────────────────

def get_sync_state(telegram_user_id: int) -> dict:
    with Session(engine) as s:
        row = s.get(SyncState, telegram_user_id)
        if row:
            return {
                "last_sync_at": row.last_sync_at.timestamp() if row.last_sync_at else 0.0,
                "newest_msg_id": row.newest_msg_id,
            }
        return {"last_sync_at": 0.0, "newest_msg_id": 0}


def update_sync_state(telegram_user_id: int, last_sync_at: Optional[float] = None, newest_msg_id: Optional[int] = None):
    with Session(engine) as s:
        row = s.get(SyncState, telegram_user_id)
        if not row:
            row = SyncState(telegram_user_id=telegram_user_id)
        if last_sync_at is not None:
            row.last_sync_at = datetime.utcfromtimestamp(last_sync_at)
        if newest_msg_id is not None and newest_msg_id > (row.newest_msg_id or 0):
            row.newest_msg_id = newest_msg_id
        s.merge(row)
        s.commit()


# ── Delete all user data ──────────────────────────────────────────────────────

def delete_all_user_data(telegram_user_id: int):
    _cred_cache.pop(telegram_user_id, None)
    _session_cache.pop(telegram_user_id, None)
    with Session(engine) as s:
        for model in (TelegramFile, Folder, SyncState, UserSettings, UserTelegramSession, UserApiCredentials, User):
            rows = s.exec(select(model).where(
                getattr(model, "telegram_user_id") == telegram_user_id
            )).all()
            for row in rows:
                s.delete(row)
        s.commit()
