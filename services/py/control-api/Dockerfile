FROM ghcr.io/astral-sh/uv:0.12.7 AS uv-bin
FROM python:3.14.7-slim-bookworm AS runtime

ENV PATH=/app/.venv/bin:$PATH
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY --from=uv-bin /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
COPY packages/py/platform-integration packages/py/platform-integration
COPY packages/py/oron-common packages/py/oron-common
COPY packages/py/oron-db packages/py/oron-db
COPY packages/py/oron-flows packages/py/oron-flows
COPY packages/py/oron-secrets packages/py/oron-secrets
COPY packages/py/oron-tenancy packages/py/oron-tenancy
COPY packages/py/oron-sessions packages/py/oron-sessions
COPY services/py/control-api services/py/control-api
COPY services/py/dispatcher services/py/dispatcher
COPY services/py/voice-agent services/py/voice-agent
RUN uv sync --frozen --no-dev --package or-on-control-api \
    && addgroup --system platform \
    && adduser --system --ingroup platform --home /app platform \
    && chown -R platform:platform /app

USER platform
EXPOSE 8000
CMD ["or-on-control-api"]
