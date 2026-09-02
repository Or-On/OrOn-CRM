"""Instruction-template rendering.

``safe_substitute`` so a ``${session_var}`` an author put in their spoken copy
survives expansion untouched and is interpolated later, at transition time, by
``oron_agent.flows.render``.
"""

from string import Template


def render_instruction(template: str, **values: str) -> str:
    return Template(template).safe_substitute(**values).strip()
