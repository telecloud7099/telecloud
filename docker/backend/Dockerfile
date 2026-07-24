# syntax=docker/dockerfile:1

# ---- Stage 1: frontend build ----
# Deliberately isolated from the backend's directory conventions (see Phase 4 discussion):
# frontend/vite.config.ts keeps the standard `dist` outDir so the Vercel deployment
# (frontend/vercel.json, root-directory=frontend) keeps working unmodified. This stage
# is the only place that knows the runtime image wants the build under static/app.
# Digest-pinned (Phase 14c, 2026-07-24) -- supply-chain integrity, not a vulnerability
# fix: locks out a surprise/malicious tag repush, doesn't change CVE exposure. Confirmed
# matching the digest already resolved on the VM before pinning (docker buildx imagetools
# inspect), so this is a no-op for what's actually running today.
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build


# ---- Stage 2: python dependency build ----
FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91 AS python-builder
WORKDIR /app

# build-essential is a safety net, not a known requirement: cryptography/psycopg2-binary/
# cryptg all resolve to prebuilt manylinux wheels on 3.13 as of this writing, so this stage
# should never actually compile anything — but it costs nothing in the final image since
# this stage is discarded, and it's cheap insurance against a future dependency that isn't
# wheel-available.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt


# ---- Stage 3: runtime ----
FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91 AS runtime

# curl is required by compose.yml's healthcheck (GET /health); everything else psycopg2-
# binary/cryptg need is bundled in their wheels, no libpq-dev or libssl-dev required here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /usr/sbin/nologin appuser

WORKDIR /app
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY --from=python-builder /opt/venv /opt/venv
COPY backend/ ./backend/
# main.py resolves static assets at ../static relative to backend/__file__, i.e. /app/static
# — this is the one place the frontend's `dist` output gets renamed into that convention.
COPY --from=frontend-builder /app/frontend/dist ./static/app

# uploads/ and thumbs/ are bind-mount targets (see compose.yml) — created here so the
# non-root user owns them even before a host directory is mounted over them.
RUN mkdir -p uploads thumbs && chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

# Single Uvicorn worker — the Telethon client pool, upload progress tracker, and resume
# logic are all in-memory and not safe to share across multiple worker processes.
#
# --forwarded-allow-ips='*' trusts X-Forwarded-For/-Proto from whoever connects directly
# to this process. backend/security.py reads request.client.host for rate limiting and
# security-event logging, so without this those would see nginx's bridge-network IP for
# every request instead of the real client. Trusting '*' is safe here specifically because
# telecloud-app has no published host port (see compose.yml) and is reachable only from
# nginx on the internal edge network — nginx is the only possible direct peer, so there is
# no one else to spoof it. This reasoning would NOT hold for a directly internet-facing app.
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
