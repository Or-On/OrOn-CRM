"""Run existing paid evals on both requested models only with explicit opt-in.

Loads only LLM_API_KEY from the explicitly named local file. Never starts a
worker, changes provider flags, or sends messages/calls to customers.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-provider-evals", action="store_true")
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.allow_provider_evals:
        parser.error("Explicit --allow-provider-evals is required")
    key = dotenv_values(args.env_file).get("LLM_API_KEY")
    if not key:
        parser.error("LLM_API_KEY is absent")
    args.output.mkdir(parents=True, exist_ok=True)
    prompt = ROOT / "infra/tenant-configurations/oron.whatsapp-lead.agent.json"
    manifest = {
        "promptSha256": hashlib.sha256(prompt.read_bytes()).hexdigest(),
        "kind": "existing provider suites; not database or service-discovery acceptance",
        "models": {},
    }
    for model in ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]:
        env = {
            **os.environ,
            "ORON_RUN_PROVIDER_EVALS": "true",
            "LLM_PROVIDER": "openai-compat",
            "LLM_BASE_URL": "https://generativelanguage.googleapis.com/v1beta/openai",
            "LLM_MODEL": model,
            "ORON_LLM_MODEL": model,
            "LLM_API_KEY": key,
            "LLM_REASONING_EFFORT": "minimal",
            "ORON_LLM_REASONING_EFFORT": "minimal",
            "LLM_MAX_TOKENS": "2048",
            "PYTHONUTF8": "1",
        }
        report = args.output / (model + ".xml")
        result = subprocess.run(  # noqa: S603 -- fixed local pytest command
            [
                sys.executable,
                "-m",
                "pytest",
                "packages/py/oron-agent/tests/eval",
                "packages/py/oron-flows/tests/eval",
                "-q",
                "--tb=short",
                "--junitxml=" + str(report),
            ],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        # Synthetic transcript/test diagnostics only; redact any accidental key echo.
        (args.output / (model + ".log")).write_text(
            (result.stdout + result.stderr).replace(key, "[REDACTED]"), encoding="utf-8"
        )
        # Parse only this process's own local pytest output.
        cases = list(ET.parse(report).iter("testcase")) if report.exists() else []  # noqa: S314
        measured = [c for c in cases if c.find("skipped") is None]
        failed = sum(c.find("failure") is not None or c.find("error") is not None for c in measured)
        times = sorted(float(c.attrib.get("time", 0)) for c in measured)
        manifest["models"][model] = {
            "exitCode": result.returncode,
            "tests": len(cases),
            "passed": len(measured) - failed,
            "failed": failed,
            "skipped": len(cases) - len(measured),
            "testDurationP50Seconds": times[len(times) // 2] if times else None,
            "testDurationP95Seconds": times[min(len(times) - 1, int(len(times) * 0.95))]
            if times
            else None,
            "latencyNote": "Whole test duration, not single inference latency",
        }
        (args.output / "summary.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
        print(json.dumps({model: manifest["models"][model]}), flush=True)
    return int(any(v["failed"] or v["skipped"] for v in manifest["models"].values()))


if __name__ == "__main__":
    raise SystemExit(main())
