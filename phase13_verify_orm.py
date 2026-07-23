"""Phase 13 diagnostic: confirms the app's own SQLModel layer -- not just raw SQL -- can
read the restored database correctly. Imports backend.database directly, which builds its
engine from DATABASE_URL at import time; this script relies on the caller overriding
DATABASE_URL for just this one process invocation (e.g. via `docker compose exec -e
DATABASE_URL=... telecloud-app python3 ...`) so the real running app's configuration is
never touched, read, or restarted.

Prints only aggregate/non-sensitive summaries (counts, folder names, categories) -- never
raw encrypted session/credential content.

Usage (from the VM host, reading the local postgres password without ever echoing it):
    export PGPASS=$(grep '^POSTGRES_PASSWORD=' .env.db | cut -d '=' -f2-)
    docker compose exec -e DATABASE_URL="postgresql://telecloud:$PGPASS@postgres:5432/telecloud_restore_test" \
        telecloud-app python3 /app/phase13_verify_orm.py
"""
from sqlmodel import Session, select

from backend.database import (
    engine,
    User,
    UserApiCredentials,
    UserTelegramSession,
    Folder,
    TelegramFile,
    FileChunk,
    UploadSession,
    SyncState,
    UserSettings,
)


def main() -> None:
    print(f"Connected via SQLModel engine: {engine.url.drivername}://.../{engine.url.database}")
    print()

    with Session(engine) as s:
        users = s.exec(select(User)).all()
        print(f"users: {len(users)} row(s), sample telegram_user_id(s) present: "
              f"{[bool(u.telegram_user_id) for u in users]}")

        creds = s.exec(select(UserApiCredentials)).all()
        print(f"user_api_credentials: {len(creds)} row(s)")

        sessions = s.exec(select(UserTelegramSession)).all()
        print(f"user_sessions: {len(sessions)} row(s)")

        folders = s.exec(select(Folder)).all()
        print(f"folders: {len(folders)} row(s)")

        files = s.exec(select(TelegramFile)).all()
        by_category = {}
        for f in files:
            by_category[f.category] = by_category.get(f.category, 0) + 1
        print(f"files: {len(files)} row(s), by category: {by_category}")

        chunks = s.exec(select(FileChunk)).all()
        print(f"file_chunks: {len(chunks)} row(s)")

        upload_sessions = s.exec(select(UploadSession)).all()
        by_status = {}
        for u in upload_sessions:
            by_status[u.status] = by_status.get(u.status, 0) + 1
        print(f"upload_sessions: {len(upload_sessions)} row(s), by status: {by_status}")

        sync_states = s.exec(select(SyncState)).all()
        print(f"sync_state: {len(sync_states)} row(s)")

        settings = s.exec(select(UserSettings)).all()
        print(f"user_settings: {len(settings)} row(s)")

    print()
    print("RESULT: all ORM-level queries completed without error against the restored database.")


if __name__ == "__main__":
    main()
