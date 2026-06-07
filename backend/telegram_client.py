import os
import hashlib
import logging
from telethon import TelegramClient

logger = logging.getLogger(__name__)

SESSIONS_FOLDER = "sessions"
os.makedirs(SESSIONS_FOLDER, exist_ok=True)

# phone → TelegramClient
_clients: dict[str, TelegramClient] = {}


def get_session_path(phone: str) -> str:
    phone_hash = hashlib.sha256(phone.encode()).hexdigest()
    return os.path.join(SESSIONS_FOLDER, f"{phone_hash}.session")


async def get_client(
    phone: str,
    api_id: int,
    api_hash: str,
    require_authorized: bool = False,
) -> TelegramClient:
    if phone in _clients:
        client = _clients[phone]
        if client.is_connected():
            if require_authorized and not await client.is_user_authorized():
                await _drop(phone)
            else:
                return client
        else:
            try:
                await client.connect()
                if require_authorized and not await client.is_user_authorized():
                    await _drop(phone)
                    return await get_client(phone, api_id, api_hash, require_authorized)
                return client
            except Exception:
                await _drop(phone)

    session_path = get_session_path(phone)
    client = TelegramClient(session_path, api_id, api_hash)
    await client.connect()

    if require_authorized and not await client.is_user_authorized():
        await client.disconnect()
        raise Exception("Telegram session not authorized. Please login again.")

    _clients[phone] = client
    return client


async def remove_client(phone: str):
    await _drop(phone)
    path = get_session_path(phone)
    if os.path.exists(path):
        os.remove(path)


async def _drop(phone: str):
    client = _clients.pop(phone, None)
    if client:
        try:
            await client.disconnect()
        except Exception:
            pass


def session_file_exists(phone: str) -> bool:
    return os.path.exists(get_session_path(phone))
