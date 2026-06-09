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

from backend.database import init_db
from backend.cache import cache_sweep
from backend.routes import auth as auth_router
from backend.routes import files as files_router
from backend.routes import folders as folders_router

load_dotenv()

_log_handler = logging.handlers.RotatingFileHandler(
    "app.log", maxBytes=5 * 1024 * 1024, backupCount=3
)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    handlers=[_log_handler, logging.StreamHandler()],
)
logger = logging.getLogger(__name__)

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")
_APP_DIR = os.path.join(_STATIC_DIR, "app")
_SPA_INDEX = os.path.join(_APP_DIR, "index.html")

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:5001")
origins = [o.strip() for o in ALLOWED_ORIGINS.split(",") if o.strip()]


async def _maintenance_loop():
    while True:
        await asyncio.sleep(900)
        try:
            cache_sweep()
        except Exception as e:
            logger.error(f"Maintenance loop error: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting TeleCloud")
    init_db()
    for d in ("uploads", "thumbs"):
        os.makedirs(d, exist_ok=True)
    task = asyncio.create_task(_maintenance_loop())
    yield
    task.cancel()
    logger.info("TeleCloud shutting down")


app = FastAPI(lifespan=lifespan, title="TeleCloud")

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)


@app.middleware("http")
async def error_middleware(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as e:
        logger.error(f"Unhandled error in {request.method} {request.url.path}: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": "Internal server error"})


app.include_router(auth_router.router)
app.include_router(files_router.router)
app.include_router(folders_router.router)

if os.path.isdir(_APP_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(_APP_DIR, "assets")), name="assets")

if os.path.isdir(_STATIC_DIR):
    app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    if full_path.startswith(("static/", "assets/")):
        return JSONResponse(status_code=404, content={"message": "Not found"})
    if os.path.isfile(_SPA_INDEX):
        return FileResponse(_SPA_INDEX)
    return JSONResponse(
        status_code=503,
        content={"message": "React app not built. Run: cd frontend && npm run build"},
    )
