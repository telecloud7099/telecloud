import asyncio
import logging
import logging.handlers
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv

from backend.database import init_db, purge_expired_api_sessions
from backend.auth import cleanup_expired_sessions, set_csrf_if_missing
from backend.telegram_client import remove_client
from backend.cache import cache_sweep
from backend.routes import auth as auth_router
from backend.routes import files as files_router
from backend.routes import folders as folders_router

load_dotenv()

# ── Logging — rotating file handler so app.log never grows unbounded ──────────

_log_handler = logging.handlers.RotatingFileHandler(
    "app.log", maxBytes=5 * 1024 * 1024, backupCount=3
)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    handlers=[_log_handler, logging.StreamHandler()],
)
logger = logging.getLogger(__name__)

# ── Paths ──────────────────────────────────────────────────────────────────────

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")
_APP_DIR = os.path.join(_STATIC_DIR, "app")
_SPA_INDEX = os.path.join(_APP_DIR, "index.html")


# ── Background maintenance ────────────────────────────────────────────────────

async def _maintenance_loop():
    while True:
        await asyncio.sleep(900)
        try:
            for phone in cleanup_expired_sessions():
                await remove_client(phone)
            cache_sweep()
            purge_expired_api_sessions()
        except Exception as e:
            logger.error(f"Maintenance loop error: {e}")


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting TeleCloud")
    init_db()
    for d in ("uploads", "sessions", "thumbs"):
        os.makedirs(d, exist_ok=True)
    task = asyncio.create_task(_maintenance_loop())
    yield
    task.cancel()
    logger.info("TeleCloud shutting down")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(lifespan=lifespan, title="TeleCloud")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5001", "http://localhost:5001", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def csrf_middleware(request: Request, call_next):
    try:
        response: Response = await call_next(request)
    except Exception as e:
        logger.error(f"Unhandled error in {request.method} {request.url.path}: {e}")
        response = JSONResponse(status_code=500, content={"status": "error", "message": "Internal server error"})
    set_csrf_if_missing(request, response)
    return response


# ── API routers ───────────────────────────────────────────────────────────────

app.include_router(auth_router.router)
app.include_router(files_router.router)
app.include_router(folders_router.router)


# ── Static files + SPA ────────────────────────────────────────────────────────

# Serve built React assets (JS/CSS/fonts) from static/app/assets/
if os.path.isdir(_APP_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(_APP_DIR, "assets")), name="assets")

# Serve any other legacy static files
if os.path.isdir(_STATIC_DIR):
    app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


# SPA catch-all — every non-API path serves index.html so React Router handles routing
@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    # Let /static and /assets requests fall through to their mounts
    if full_path.startswith(("static/", "assets/")):
        return JSONResponse(status_code=404, content={"message": "Not found"})
    if os.path.isfile(_SPA_INDEX):
        return FileResponse(_SPA_INDEX)
    return JSONResponse(
        status_code=503,
        content={"message": "React app not built. Run: cd frontend && npm run build"},
    )
