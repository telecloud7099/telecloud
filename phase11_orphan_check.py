"""Phase 11 Scenario 8 diagnostic: read-only search of Saved Messages for any chunk message
tied to a specific upload session (by its caption group_id), to directly verify -- not infer
-- whether the docker-kill test left an orphaned Telegram message behind.

Chunk captions are built by build_chunk_caption() in chunk_upload.py as:
    __tc_chunk__:<group_id>:<part_number>:<total_chunks>:<filename>

This script only reads messages and prints what it finds. It does not delete, edit, or send
anything.

Usage:
    docker exec telecloud-app python3 phase11_orphan_check.py <telegram_user_id> <session_id>
"""
import asyncio
import sys

from backend.telegram_client import get_user_client
from backend.chunk_upload import parse_chunk_caption


async def main(telegram_user_id: int, session_id: str) -> None:
    client = await get_user_client(telegram_user_id, require_authorized=True)

    print(f"Searching Saved Messages for chunk captions matching group_id={session_id} ...")
    found = []
    checked = 0
    async for msg in client.iter_messages("me", limit=2000):
        checked += 1
        parsed = parse_chunk_caption(msg.message)
        if parsed and parsed["group_id"] == session_id:
            found.append((msg.id, msg.date, msg.file.size if msg.file else None, msg.message))

    await client.disconnect()

    print(f"Checked {checked} recent messages in Saved Messages.")
    print()
    if not found:
        print(f"RESULT: NO messages found with group_id={session_id} -- no orphan exists, "
              f"confirmed by direct observation (not inference).")
    else:
        print(f"RESULT: {len(found)} matching message(s) found for group_id={session_id}:")
        for msg_id, date, size, caption in found:
            print(f"  message_id={msg_id} date={date} size={size} caption={caption!r}")
        print()
        print("Compare these message_ids against the FileChunk table for this session_id -- "
              "any message_id NOT present there is a genuine orphan.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python3 phase11_orphan_check.py <telegram_user_id> <session_id>")
        sys.exit(1)
    asyncio.run(main(int(sys.argv[1]), sys.argv[2]))
