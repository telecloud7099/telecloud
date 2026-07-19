# syntax=docker/dockerfile:1

# Pure reverse proxy (Option A: FastAPI serves the SPA, not nginx) — nothing to build,
# just the config baked in so it's versioned with the rest of the stack rather than
# depending on a bind-mounted host path.
FROM nginx:1.27-alpine

COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
