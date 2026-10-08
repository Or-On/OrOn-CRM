"""Summarize retained real-provider attempts; never starts a provider operation."""

import argparse
import hashlib
import json
import math
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    reports = []
    for channel in ("whatsapp", "voice"):
        path = args.directory / f"{channel}.json"
        data = json.loads(path.read_text(encoding="utf8"))
        for model in sorted({row["model"] for row in data["results"]}):
            rows = [row for row in data["results"] if row["model"] == model]
            attempts = [attempt for row in rows for attempt in row["attempts"]]
            latencies = sorted(attempt["latencyMs"] for attempt in attempts)

            def percentile(p, values=latencies):
                return values[max(0, math.ceil(len(values) * p) - 1)] if values else None

            reports.append(
                {
                    "channel": channel,
                    "model": model,
                    "scenarios": len(rows),
                    "passed": sum(not row["failures"] for row in rows),
                    "failures": {row["id"]: row["failures"] for row in rows if row["failures"]},
                    "attempts": len(attempts),
                    "attemptLatencyMsP50": percentile(0.5),
                    "attemptLatencyMsP95": percentile(0.95),
                    "failedAttempts": sum(attempt["status"] != "succeeded" for attempt in attempts),
                    "promptSha256": data["promptSha256"],
                    "sourceReportSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "environment": data.get("environment"),
                }
            )
    with args.output.open("x", encoding="utf8") as output:
        json.dump(
            {
                "measurement": "Nearest-rank per physical model attempt, including failures. "
                "Not end-to-end customer latency. Synthetic storage; no transport acceptance.",
                "reports": reports,
            },
            output,
            ensure_ascii=False,
            indent=2,
        )


if __name__ == "__main__":
    main()
