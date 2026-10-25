# api/index.py — Vercel entry point
# Vercel runs this file from the project root, so `backend` package imports work fine.
from backend.main import app  # noqa: F401 — Vercel detects the `app` ASGI object
