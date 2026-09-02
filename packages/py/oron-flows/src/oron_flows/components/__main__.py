"""Dump the registered component specs to stdout as JSON.

    uv run python -m oron_flows.components > catalog.json

Consumed by the MCP flow-authoring agent and any future builder UI. The shape
matches the planned `/component-types` HTTP response, so either source works.
"""

import json
import sys

import oron_flows.components.library  # noqa: F401 — import registers the components
from oron_flows.components import export_catalog


def main() -> None:
    json.dump(export_catalog(), sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
