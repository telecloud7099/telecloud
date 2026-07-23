"""One-off diagnostic: connect to Telegram via Telethon directly, bypassing the app's
12-second timeout wrapper in telegram_client.py, with verbose logging enabled so we can
see exactly what Telethon is doing during the handshake (which DC/IP, how long each step
takes) and a much longer timeout to distinguish "just needs more time" from "genuinely
stuck". Reuses the same encrypted credentials/session the app itself uses.

Not part of the app -- throwaway diagnostic for the Phase 11 resilience test finding that
reconnecting to Telegram after a backend restart has been failing for 10+ minutes.

Usage (inside the container, since it needs Telethon + DATABASE_URL/ENCRYPTION_KEY):
    docker compose exec telecloud-app python3 telethon_connect_debug.py <telegram_user_id>
"""
import asyncio
import logging
import sys
import time

logging.basicConfig(level=logging.DEBUG, format="%(asctime)s %(name)s %(levelname)s %(message)s")

from telethon import TelegramClient
from telethon.sessions import StringSession

from backend.database import get_api_credentials, load_string_session


async def main(telegram_user_id: int) -> None:
    api_id, api_hash = get_api_credentials(telegram_user_id)
    string_session = load_string_session(telegram_user_id) or ""
    print(f"api_id present: {bool(api_id)}, string_session length: {len(string_session)}")

    session = StringSession(string_session) if string_session else StringSession()
    client = TelegramClient(session, api_id, api_hash, connection_retries=1)

    print("Starting client.connect() with a 60s timeout...")
    t0 = time.monotonic()
    try:
        await asyncio.wait_for(client.connect(), timeout=60)
        elapsed = time.monotonic() - t0
        print(f"connect() succeeded in {elapsed:.2f}s")
        authorized = await client.is_user_authorized()
        print(f"is_user_authorized: {authorized}")
        me = await client.get_me()
        print(f"get_me(): {me}")
    except Exception as e:
        elapsed = time.monotonic() - t0
        print(f"connect() FAILED after {elapsed:.2f}s: {type(e).__name__}: {e}")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 telethon_connect_debug.py <telegram_user_id>")
        sys.exit(1)
    asyncio.run(main(int(sys.argv[1])))
