FROM python:3.12-slim

# System deps:
#   ffmpeg — recording-agent worker uses libopus encode via ffmpeg.
#   curl   — for the NodeSource bootstrap below.
#   ca-certificates — TLS for the NodeSource fetch + npm registry.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        ca-certificates \
        gnupg \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (current active LTS). The recording-agent worker is ESM with
# native @livekit/rtc-node bindings; package.json pins
# `engines.node >=20`, so 22 satisfies it. AWS SDK v3 also drops Node 20
# support in early 2027 — starting on 22 avoids a forced bump later.
# NodeSource ships a prebuilt apt repo so we get a real `node` on $PATH;
# the worker is spawned by the Python orchestrator via
# `asyncio.create_subprocess_exec("node", ...)`.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app/ ./app/
COPY backend/alembic/ ./alembic/
COPY backend/alembic.ini .
COPY backend/scripts/ ./scripts/

# Recording-agent worker — joins upstream LiveKit room as a passive
# listener, mixes via @livekit/rtc-node + ffmpeg, uploads OGG/Opus to
# S3. Self-contained Node project with its own package.json.
# `npm ci` over `install` for reproducible builds in CI.
COPY backend/recording_agent/ ./recording_agent/
RUN cd recording_agent && npm ci --omit=dev

# `exec` so uvicorn replaces the shell and becomes PID 1 — otherwise the
# shell swallows SIGTERM on redeploy and uvicorn never runs its graceful
# shutdown (the lifespan handler that finalizes in-flight recordings).
# `--timeout-graceful-shutdown` must exceed RECORDING_DRAIN_TIMEOUT_SECONDS
# so the drain has room to flush + upload before uvicorn forces exit.
CMD ["/bin/sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --timeout-graceful-shutdown 45"]
