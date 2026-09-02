from collections import defaultdict
from collections.abc import Mapping
from string import Template
from typing import Any

from oron_flows.node import ActionType
from pipecat.flows import NodeConfig


def _sub(text: str, values: Mapping[str, str]) -> str:
    return Template(text).safe_substitute(values)


def render_node(config: NodeConfig, session: Mapping[str, Any]) -> NodeConfig:
    """Copy `config`, interpolating ${var} from session (str/number values) in
    pre_actions and task text. Missing vars render empty, never literal.

    Rebuilds only the keys it rewrites — the bound function schemas are shared and
    carry no ${var}, so deep-copying them on every transition is pure waste.
    """
    values = defaultdict(
        str, {k: str(v) for k, v in session.items() if isinstance(v, (str, int, float))}
    )
    out: NodeConfig = dict(config)  # pyrefly: ignore[bad-assignment]
    if pre_actions := config.get("pre_actions"):
        out["pre_actions"] = [
            {**pa, "text": _sub(pa["text"], values)}
            if pa.get("type") == ActionType.tts_say and "text" in pa
            else pa
            for pa in pre_actions
        ]
    if task_messages := config.get("task_messages"):
        out["task_messages"] = [
            {**m, "content": _sub(m["content"], values)} if "content" in m else m
            for m in task_messages
        ]
    return out
