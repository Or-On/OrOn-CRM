"""Parameters for the configured compatibility endpoint, for each attempt."""

from urllib.parse import urlsplit

from oron_agent.runtime_policy import RUNTIME_POLICY


def compatible_parameters(base_url: str, model: str, temperature: float, effort=None) -> dict:
    result: dict[str, object] = {"temperature": temperature}
    if effort is not None:
        result["reasoning_effort"] = str(effort)
    if urlsplit(base_url).hostname != "generativelanguage.googleapis.com":
        return result
    capability = RUNTIME_POLICY["models"].get(model)
    if capability:
        result["reasoning_effort"] = capability["reasoningEffort"]
        if not capability["sampling"]:
            result.pop("temperature", None)
    elif model.startswith(("gemini-3", "gemini-2.5-pro")):
        result["reasoning_effort"] = "minimal"
    elif model.startswith("gemini-2.5-flash"):
        result["reasoning_effort"] = "none"
    return result


def validate_fallback(base_url: str, model: str, fallback: str | None) -> None:
    if not fallback:
        return
    hostname = urlsplit(base_url).hostname
    if hostname == "generativelanguage.googleapis.com" and (
        not model.startswith("gemini-") or fallback not in RUNTIME_POLICY["models"]
    ):
        raise ValueError("Unsupported Gemini fallback model")
    if hostname == "api.openai.com" and fallback.startswith("gemini-"):
        raise ValueError("Fallback provider mismatch")
