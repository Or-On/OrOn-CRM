FROM ghcr.io/astral-sh/uv:0.12.7@sha256:95f2aa1fe59274951cfe9b0cbc7972e879ff1004bc8945d130a32eb0dbd85945 AS uv-bin
FROM python:3.14.7-slim-bookworm@sha256:9ab8d9c8514b44f90cf0029dd42fdd7e9e211e639c8b995304cc04568dee900f AS runtime

ARG ORON_SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision="${ORON_SOURCE_REVISION}"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends libpcre2-8-0=10.42-1+deb12u1 libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

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
COPY packages/py/oron-hebrew packages/py/oron-hebrew
COPY packages/py/oron-agent packages/py/oron-agent
COPY packages/py/oron-secrets packages/py/oron-secrets
COPY packages/py/oron-tenancy packages/py/oron-tenancy
COPY packages/py/oron-sessions packages/py/oron-sessions
COPY services/py/control-api services/py/control-api
COPY services/py/dispatcher services/py/dispatcher
COPY services/py/voice-agent services/py/voice-agent
RUN uv sync --frozen --no-dev --package or-on-control-api --extra voice \
    && uv pip uninstall nltk \
    && python -c "import control_api.app; import oron_agent.agent_evaluation" \
    && addgroup --system platform \
    && adduser --system --ingroup platform --home /app platform \
    && chown -R platform:platform /app

USER platform
EXPOSE 8000
CMD ["or-on-control-api"]
