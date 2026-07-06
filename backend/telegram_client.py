import asyncio
import logging
import time as _time
from telethon import TelegramClient
from telethon.sessions import StringSession

logger = logging.getLogger(__name__)

# telegram_user_id → TelegramClient (in-memory pool; rebuilt from DB on restart)
_clients: dict[int, TelegramClient] = {}
# Per-user lock to prevent concurrent client creation (race condition)
_connect_locks: dict[int, asyncio.Lock] = {}
# Timestamp of last connection failure — drives 30-second backoff
_connect_failed_at: dict[int, float] = {}

CONNECT_BACKOFF = 30  # seconds to wait after a connection failure before retrying


def is_client_connected(telegram_user_id: int) -> bool:
    client = _clients.get(telegram_user_id)
    return client is not None and client.is_connected()


def _get_lock(user_id: int) -> asyncio.Lock:
    if user_id not in _connect_locks:
        _connect_locks[user_id] = asyncio.Lock()
    return _connect_locks[user_id]


async def get_client(
    telegram_user_id: int,
    api_id: int,
    api_hash: str,
    string_session: str = "",
    require_authorized: bool = False,
) -> TelegramClient:
    # Fast path: return connected client without acquiring the lock
    if telegram_user_id in _clients:
        client = _clients[telegram_user_id]
        if client.is_connected():
            if require_authorized and not await client.is_user_authorized():
                await _drop(telegram_user_id)
            else:
                _connect_failed_at.pop(telegram_user_id, None)
                return client

    # Backoff: if we recently failed, reject immediately (don't hold the lock for 12 seconds)
    last_failure = _connect_failed_at.get(telegram_user_id, 0)
    if _time.time() - last_failure < CONNECT_BACKOFF:
        secs = int(CONNECT_BACKOFF - (_time.time() - last_failure))
        raise Exception(f"Telegram connection unavailable, retrying in {secs}s")

    # Slow path: create / reconnect under a per-user lock to avoid concurrent connections
    async with _get_lock(telegram_user_id):
        # Re-check inside the lock in case another coroutine already created it
        if telegram_user_id in _clients:
            client = _clients[telegram_user_id]
            if client.is_connected():
                if require_authorized and not await client.is_user_authorized():
                    await _drop(telegram_user_id)
                else:
                    _connect_failed_at.pop(telegram_user_id, None)
                    return client
            else:
                try:
                    await asyncio.wait_for(client.connect(), timeout=12)
                    if require_authorized and not await client.is_user_authorized():
                        await _drop(telegram_user_id)
                    else:
                        _connect_failed_at.pop(telegram_user_id, None)
                        return client
                except Exception:
                    await _drop(telegram_user_id)

        session = StringSession(string_session) if string_session else StringSession()
        # connection_retries=1: one attempt — avoids 37-second OS TCP timeout loops
        client = TelegramClient(session, api_id, api_hash, connection_retries=1)
        try:
            await asyncio.wait_for(client.connect(), timeout=12)
        except (asyncio.TimeoutError, Exception) as e:
            _connect_failed_at[telegram_user_id] = _time.time()
            logger.warning(f"Telegram connect failed for user {telegram_user_id}: {e}")
            try:
                await asyncio.wait_for(client.disconnect(), timeout=3)
            except Exception:
                pass
            raise Exception("Telegram connection timed out. Please try again.")

        if require_authorized and not await client.is_user_authorized():
            await client.disconnect()
            _connect_failed_at[telegram_user_id] = _time.time()
            raise Exception("Telegram session not authorized. Please login again.")

        _connect_failed_at.pop(telegram_user_id, None)
        _clients[telegram_user_id] = client
        return client


async def get_unauthenticated_client(phone: str, api_id: int, api_hash: str) -> TelegramClient:
    """Fresh client for OTP flow — keyed by phone, not user_id (user_id unknown yet)."""
    key = f"pre:{phone}"
    if key in _clients:  # type: ignore[operator]
        client = _clients[key]  # type: ignore[index]
        if client.is_connected():
            return client
        try:
            await asyncio.wait_for(client.connect(), timeout=12)
            return client
        except Exception:
            del _clients[key]  # type: ignore[arg-type]

    client = TelegramClient(StringSession(), api_id, api_hash, connection_retries=1)
    try:
        await asyncio.wait_for(client.connect(), timeout=12)
    except (asyncio.TimeoutError, Exception) as e:
        logger.warning(f"Unauthenticated Telegram connect failed for {phone}: {e}")
        try:
            await asyncio.wait_for(client.disconnect(), timeout=3)
        except Exception:
            pass
        raise Exception("Telegram connection timed out. Please try again.")
    _clients[key] = client  # type: ignore[index]
    return client


def get_string_session(telegram_user_id: int) -> str:
    client = _clients.get(telegram_user_id)
    if client and hasattr(client.session, "save"):
        return client.session.save()
    return ""


async def remove_client(telegram_user_id: int):
    await _drop(telegram_user_id)


def get_pre_auth_client(phone: str):
    """Return the existing pre-auth client for a phone, or None."""
    return _clients.get(f"pre:{phone}")  # type: ignore[arg-type]


def promote_pre_auth_client(phone: str, telegram_user_id: int):
    """Move the pre-auth client (keyed by phone) into the main pool (keyed by user_id)."""
    key = f"pre:{phone}"
    client = _clients.pop(key, None)  # type: ignore[arg-type]
    if client:
        _clients[telegram_user_id] = client


async def remove_pre_auth_client(phone: str):
    key = f"pre:{phone}"
    client = _clients.pop(key, None)  # type: ignore[arg-type]
    if client:
        try:
            await client.disconnect()
        except Exception:
            pass


async def _drop(key):
    client = _clients.pop(key, None)
    if client:
        try:
            await asyncio.wait_for(client.disconnect(), timeout=5)
        except Exception:
            pass


def get_active_sessions() -> dict:
    user_ids = [k for k in _clients if isinstance(k, int) and _clients[k].is_connected()]
    return {"count": len(user_ids), "user_ids": user_ids}
