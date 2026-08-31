"""Control API executable entrypoint."""

import uvicorn


def main() -> None:
    uvicorn.run(
        "control_api.app:create_app",
        factory=True,
        host="127.0.0.1",
        port=8000,
        log_config=None,
    )


if __name__ == "__main__":
    main()
