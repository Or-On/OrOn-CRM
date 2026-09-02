from oron_agent.flows.render import render_node


def test_render_substitutes_and_blanks_missing():
    cfg = {
        "pre_actions": [{"type": "tts_say", "text": "כתובת: ${address}"}],
        "task_messages": [{"role": "system", "content": "hi ${customer_name}${missing}"}],
    }
    out = render_node(cfg, {"address": "רחוב א 1", "customer_name": "כהן"})
    assert out["pre_actions"][0]["text"] == "כתובת: רחוב א 1"
    assert out["task_messages"][0]["content"] == "hi כהן"
    # original not mutated
    assert cfg["pre_actions"][0]["text"] == "כתובת: ${address}"
