"""Standalone diagnostic: does Telegram/Telethon rewrite DocumentAttributeFilename values
for filenames matching a "double extension" pattern (e.g. video.part1.mp4)?

Not part of the app -- ad hoc verification for the claim in chunk_upload.py's module
docstring. Sends a handful of tiny throwaway documents to your own Saved Messages via
send_file(attributes=[DocumentAttributeFilename(...)]), then re-fetches each message fresh
from Telegram (a separate round-trip, not the locally-echoed send_file() response) and
compares the filename at each stage. Messages are deliberately left in Saved Messages
afterward so you can also inspect them in whichever Telegram client app you use.

Usage (run from repo root, same env as the backend so DATABASE_URL/ENCRYPTION_KEY resolve
via database.py's own load_dotenv()):

    venv/Scripts/python.exe filename_mangling_test.py <telegram_user_id>

    # or inside the VM container:
    docker compose exec telecloud-app python filename_mangling_test.py <telegram_user_id>

<telegram_user_id> is the numeric Telegram user ID already stored for your account in the
user_api_credentials / user_telegram_sessions tables -- the same ID get_user_client() uses
everywhere else in the app.
"""
import asyncio
import os
import sys
import tempfile

import telethon
from telethon.tl import alltlobjects
from telethon.tl.types import DocumentAttributeFilename

from backend.telegram_client import get_user_client

TEST_FILENAMES = [
    "plain.mp4",
    "video.part1.mp4",
    "report.v2.final.pdf",
    "archive.tar.gz",
    "file.with.many.dots.txt",
]


async def main(telegram_user_id: int) -> None:
    print(f"Telethon version: {telethon.__version__}")
    print(f"MTProto API layer: {alltlobjects.LAYER}")
    print(f"Telegram user id: {telegram_user_id}")
    print()

    client = await get_user_client(telegram_user_id, require_authorized=True)
    me = await client.get_me()

    results = []
    for name in TEST_FILENAMES:
        fd, tmp_path = tempfile.mkstemp(suffix=".bin")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(f"telecloud filename-mangling test: {name}\n".encode())

            msg = await client.send_file(
                "me", tmp_path, force_document=True,
                caption=f"filename-mangle-test: {name}",
                attributes=[DocumentAttributeFilename(file_name=name)],
            )
            immediate_name = msg.file.name if msg.file else None
            results.append((name, immediate_name, msg.id))
        finally:
            os.remove(tmp_path)

    # Re-fetch fresh from Telegram to rule out send_file()'s response being a client-side
    # echo of what was requested rather than what the server actually stored.
    ids = [r[2] for r in results]
    refetched = await client.get_messages("me", ids=ids)
    refetched_by_id = {m.id: (m.file.name if m and m.file else None) for m in refetched if m}

    await client.disconnect()

    header = f"{'original':<28} {'send_file() name':<20} {'refetched name':<20} {'msg_id':<10} match"
    print(header)
    print("-" * len(header))
    all_match = True
    for name, immediate_name, msg_id in results:
        refetched_name = refetched_by_id.get(msg_id)
        match = name == immediate_name == refetched_name
        all_match &= match
        print(f"{name:<28} {str(immediate_name):<20} {str(refetched_name):<20} {msg_id:<10} {'YES' if match else 'NO'}")

    print()
    print("Cross-check in your Telegram client (Saved Messages):")
    for name, _, msg_id in results:
        # tg://openmessage is the same deep-link scheme Telegram Desktop/Android use to jump
        # to a message from global search results. Saved Messages has no official t.me/...
        # permalink (that only exists for channels/supergroups), so this is the best
        # available link -- not guaranteed to work on every client/platform (e.g. web/iOS
        # may ignore it). If it doesn't open your app, search Saved Messages for the
        # caption text "filename-mangle-test: <name>" instead -- that always works.
        print(f"  msg_id={msg_id:<10} name={name:<28} tg://openmessage?user_id={me.id}&message_id={msg_id}")
    print()
    if all_match:
        print("RESULT: all filenames survived unchanged -- no mangling observed on this "
              "account/Telethon version. The chunk_upload.py docstring's warning is not "
              "reproduced here and should be reviewed/updated.")
    else:
        print("RESULT: at least one filename was altered -- see table above for the exact "
              "before/after. The chunk_upload.py docstring's warning is reproduced.")
    print()
    print("Messages were left in Saved Messages -- open Telegram (any client/version) to "
          "also inspect them visually and note which client app you checked with.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python filename_mangling_test.py <telegram_user_id>")
        sys.exit(1)
    asyncio.run(main(int(sys.argv[1])))
