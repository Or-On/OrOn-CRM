# Local Compose topology

`compose.yaml` declares the `core` profile. PostgreSQL is pinned to the selected
18.6 Debian image, uses a named volume and private bridge, and binds only to host
loopback on port 5433 by default. Application containers are added after their
minimal Docker builds exist; the documented host-development mode remains the
fastest Phase 1 workflow.

Future `voice`, `integrations`, and `observability` profiles may add retained
engines. Redis may coordinate LiveKit or cache data but never becomes authoritative
application state.
