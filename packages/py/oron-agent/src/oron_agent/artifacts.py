import shutil
import tempfile
import uuid
from pathlib import Path

from oron_agent.storage import RECORDING_PATH, TRANSCRIPT_PATH


class SessionDir:
    """The local staging directory for one session's artifacts.

    Artifacts are written here during the call and uploaded wholesale at
    teardown. The tree mirrors the remote layout exactly, so an upload is a
    straight copy with no path translation.
    """

    def __init__(self, session_id: uuid.UUID, root: str | None = None):
        base = Path(root) if root else Path(tempfile.gettempdir()) / "oron-sessions"
        self._base = base.resolve()
        self._session_id = session_id
        self.path = self._base / str(session_id)
        for relative in (RECORDING_PATH, TRANSCRIPT_PATH):
            (self.path / relative).parent.mkdir(parents=True, exist_ok=True)
        (self.path / "diagnostics").mkdir(parents=True, exist_ok=True)

    @property
    def recording(self) -> str:
        return str(self.path / RECORDING_PATH)

    @property
    def transcript(self) -> str:
        return str(self.path / TRANSCRIPT_PATH)

    @property
    def text_diagnostics(self) -> str:
        return str(self.path / "diagnostics/voice-turns.json")

    def cleanup(self) -> None:
        """Remove only this owned staging tree, after upload and DB finalization."""
        resolved = self.path.resolve()
        if resolved.parent != self._base or resolved.name != str(self._session_id):
            raise ValueError("refusing to remove an unowned artifact staging directory")
        if self.path.exists():
            shutil.rmtree(resolved)
