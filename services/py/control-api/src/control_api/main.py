"""Control API executable entrypoint."""

import uvicorn
from or_on_platform.config import PlatformSettings

from control_api.app import create_app


def main() -> None:
    settings = PlatformSettings.load(require_database=True, service="control-api")
    uvicorn.run(
        create_app(settings=settings),
        host=settings.control_api_bind_host,
        port=8000,
        log_config=None,
    )


if __name__ == "__main__":
    main()
