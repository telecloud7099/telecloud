# syntax=docker/dockerfile:1

# Pure reverse proxy (Option A: FastAPI serves the SPA, not nginx) — nothing to build,
# just the config baked in so it's versioned with the rest of the stack rather than
# depending on a bind-mounted host path.
# Digest-pinned (Phase 14c, 2026-07-24) -- supply-chain integrity, not a vulnerability
# fix: locks out a surprise/malicious tag repush, doesn't change CVE exposure. Confirmed
# matching the digest already resolved on the VM before pinning.
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
