"""Migrate only the exact task-owned loopback synthetic database."""

import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from alembic import command
from alembic.config import Config

url = urlsplit(os.environ["DATABASE_URL"])
assert url.hostname == "127.0.0.1" and url.port == 55480
assert url.path[1:] in {"oron_task3_test", "oron_ui_preview_7c8a460108b3437ea6e7f1a2ded00003"}
config = Config()
config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "db/alembic"))
command.upgrade(config, "d1e7a304269b")
