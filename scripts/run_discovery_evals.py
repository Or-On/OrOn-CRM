"""Explicitly opted-in real model probes; never loads transport credentials or sends messages."""

import argparse
import os
import shutil
import subprocess
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
    node = shutil.which("node")
    if not key or not node:
        parser.error("Explicit LLM_API_KEY and Node runtime are required")
    pnpm = shutil.which("pnpm")
    if not pnpm:
        parser.error("pnpm is required to build the exact evaluated shared policy")
    subprocess.run(  # noqa: S603 -- fixed local build; no provider operation
        [pnpm, "--filter", "@or-on/crm...", "build"],
        cwd=ROOT,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    args.output.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "ORON_RUN_PROVIDER_EVALS": "true",
        "LLM_API_KEY": key,
        "SERVICE_DISCOVERY_EVAL_OUTPUT": str(args.output.resolve()),
        "PYTHONUTF8": "1",
    }
    result = subprocess.run(  # noqa: S603 -- fixed repository evaluator, explicit opt-in
        [
            node,
            "node_modules/tsx/dist/cli.mjs",
            "scripts/eval_service_discovery.ts",
            "--allow-provider-evals",
        ],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
        timeout=3600,
    )
    log = (result.stdout + result.stderr).replace(key, "[REDACTED]")
    (args.output / "whatsapp.log").write_text(log, encoding="utf-8")
    print(log, flush=True)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
