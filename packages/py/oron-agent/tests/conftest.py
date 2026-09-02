import pytest


class FakeFlowManager:
    """Stands in for pipecat's FlowManager: handlers only ever touch `.state`."""

    def __init__(self) -> None:
        self.state: dict = {}


@pytest.fixture
def flow_manager() -> FakeFlowManager:
    return FakeFlowManager()


def pytest_configure(config):
    config.addinivalue_line("markers", "asyncio: async test")
