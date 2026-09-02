"""Preview destination safety without connecting to any database."""

import pytest

from scripts.preview_ui import isolated_url


def test_preview_url_is_local_owned_and_discards_source_query() -> None:
    assert (
        isolated_url(
            "postgresql://fixture@127.0.0.1:5433/developer?application_name=old",
            "oron_ui_preview_abc123",
        )
        == "postgresql://fixture@127.0.0.1:5433/oron_ui_preview_abc123"
    )


@pytest.mark.parametrize(
    ("source", "database"),
    [
        ("postgresql://fixture@example.com/postgres", "oron_ui_preview_abc"),
        ("sqlite:///tmp/example", "oron_ui_preview_abc"),
        ("postgresql://localhost/postgres", "or_on_platform_dev"),
        ("postgresql://localhost/postgres", "oron_ui_preview_"),
        ("postgresql://localhost/postgres", 'oron_ui_preview_x";DROP DATABASE postgres;'),
    ],
)
def test_preview_rejects_unowned_or_remote_destinations(source: str, database: str) -> None:
    with pytest.raises(ValueError):
        isolated_url(source, database)
