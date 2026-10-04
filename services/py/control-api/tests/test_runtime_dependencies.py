"""Control API ordinary startup must not require optional media/ML packages."""

import subprocess
import sys
import textwrap


def test_control_api_boots_without_optional_voice_provider_imports():
    script = textwrap.dedent("""
        import importlib.abc
        import sys
        class BlockVoiceImports(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                blocked = {'livekit', 'pipecat', 'torch', 'onnxruntime',
                           'nltk', 'renikud_onnx'}
                if fullname.split('.')[0] in blocked:
                    raise ModuleNotFoundError('optional voice dependency blocked by test')
                return None
        sys.meta_path.insert(0,BlockVoiceImports())
        from control_api.app import create_app
        from or_on_platform.config import PlatformSettings
        from fastapi.testclient import TestClient
        class Probe:
            async def is_ready(self): return True
            async def close(self): pass
        settings=PlatformSettings(_env_file=None,PLATFORM_ENV='test',DATABASE_URL=None,
                                  VOICE_DATABASE_URL=None,AUTH_SERVICE_SECRET=None)
        with TestClient(create_app(settings=settings,database_probe=Probe())) as client:
            assert client.get('/health/live').status_code==200
            assert client.get('/health/ready').status_code==200
        print('PASS optional media/ML imports absent during ordinary control API startup')
    """)
    result = subprocess.run(  # noqa: S603 -- Fixed local interpreter/script, no user input.
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=20
    )
    assert result.returncode == 0, result.stderr
    assert "PASS optional media/ML imports absent" in result.stdout
