# Hermes container image.
#
# Deliberately minimal: it ships uv + Python only, NOT the app code. The code is
# bind-mounted at runtime (see docker-compose.yml) so the container runs whatever
# is checked out on the VPS host — edit locally, sync to the host, restart.
#
# The virtualenv lives at /opt/venv (OUTSIDE the bind-mount) so it isn't shadowed
# by the mounted repo and persists in a named volume across restarts.
FROM python:3.12-slim

# uv, copied from its official image.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app/services/hermes

# On start: sync deps into /opt/venv (fast when cached), then run the server.
CMD ["bash", "-lc", "uv sync --no-dev && exec uv run hermes-serve"]
