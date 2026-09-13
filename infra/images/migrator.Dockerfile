FROM ghcr.io/astral-sh/uv:0.12.7@sha256:95f2aa1fe59274951cfe9b0cbc7972e879ff1004bc8945d130a32eb0dbd85945 AS uv-bin
FROM python:3.14.7-slim-bookworm@sha256:9ab8d9c8514b44f90cf0029dd42fdd7e9e211e639c8b995304cc04568dee900f
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libpcre2-8-0=10.42-1+deb12u1 \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/app/.venv/bin:$PATH
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=uv-bin /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
COPY packages/py packages/py
COPY services/py services/py
COPY db db
COPY infra/scripts/migrate.py infra/scripts/migrate.py
# Alembic is a locked development tool; this one-shot tooling image is never a server.
RUN uv sync --frozen --package or-on-control-api \
    && addgroup --system platform \
    && adduser --system --ingroup platform --home /app platform \
    && chown -R platform:platform /app
USER platform
CMD ["python", "infra/scripts/migrate.py"]
