"""Opt-in semantic probes using the real streaming voice adapter and lead tools.

No LiveKit, STT, TTS, phone calls or customer database. The synthetic store is
deliberate: separate real PostgreSQL suites establish durability and isolation.
"""

import argparse
import asyncio
import hashlib
import importlib.util
import json
import platform
import re
import sys
from pathlib import Path
from typing import Any

from dispatcher_runtime.support_context import TenantSupportProfile, compile_voice_runtime_prompt
from dotenv import dotenv_values
from loguru import logger
from oron_agent.lead_capture import (
    AcceptedTurns,
    LeadStoreRefusal,
    VoiceLeadTools,
    parse_lead_field_schema,
)
from oron_agent.llm import LlmProvider, LlmReasoningEffort, build_llm
from oron_agent.scope_policy import approved_response, classify_turn, repeated_scope_redirect
from oron_agent.spoken_safety import BusinessClaimGuardFilter
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.openai.llm import OpenAILLMService

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "synthetic_lead_store", ROOT / "packages/py/oron-agent/tests/eval/test_lead_capture_eval.py"
)
assert SPEC and SPEC.loader
FIXTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURE)


class DiscoveryStore(FIXTURE.EvalStore):
    def __init__(self, scenario, schema):
        super().__init__()
        self.scenario, self.schema, self.finals = scenario, schema, 0
        if scenario.get("completed"):
            self.lead["status"] = "ready_for_review"

    async def save_fields(self, lead_id, operation_key, observations):
        if self.scenario.get("failSave"):
            raise LeadStoreRefusal("unavailable", "synthetic storage failure")
        if self.lead["status"] == "ready_for_review":
            raise LeadStoreRefusal("completed", "this enquiry is complete")
        return await super().save_fields(lead_id, operation_key, observations)

    async def finalize(self, lead_id, operation_key, summary, next_action):
        if self.lead["status"] == "ready_for_review":
            raise LeadStoreRefusal("completed", "this enquiry is already complete")
        for field in self.schema.fields:
            value = self.fields.get(field.key, {})
            if value.get("state") != "known" or not value.get("normalizedValue"):
                raise LeadStoreRefusal("not_ready", "required discovery facts missing")
        if any(
            self.fields[k]["normalizedValue"] != "true"
            for k in ("follow_up_allowed", "discussion_complete")
        ):
            raise LeadStoreRefusal("not_ready", "follow-up readiness missing")
        result = await super().finalize(lead_id, operation_key, summary, next_action)
        self.finals += 1
        return result


async def completion(llm, messages, tools):
    """Reassemble only this synthetic probe's stream, retaining provider tool metadata."""
    stream = await llm.get_chat_completions(LLMContext(messages, tools=tools))
    content, calls = [], {}
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta.content:
            content.append(delta.content)
        for part in delta.tool_calls or []:
            call = calls.setdefault(
                part.index,
                {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
            )
            if part.id:
                call["id"] = part.id
            if part.function:
                if part.function.name:
                    call["function"]["name"] += part.function.name
                call["function"]["arguments"] += part.function.arguments or ""
            # Google thought signatures are opaque; never strip or synthesize them.
            for key, value in (part.model_extra or {}).items():
                call[key] = value
    message: dict[str, Any] = {"role": "assistant", "content": "".join(content) or None}
    if calls:
        message["tool_calls"] = [calls[i] for i in sorted(calls)]
    return message


async def scenario_run(model, key, scenario, instructions):
    schema = parse_lead_field_schema(instructions["fields"])
    store, turns = DiscoveryStore(scenario, schema), AcceptedTurns()
    tools = VoiceLeadTools(
        store=store,
        schema=schema,
        capabilities=FIXTURE.FULL_CAPABILITIES,
        interaction_key=f"discovery-{scenario['id']}",
        turns=turns,
    )
    attempts = []

    async def record(attempt):
        attempts.append(attempt)

    llm = build_llm(
        LlmProvider.OPENAI_COMPAT,
        project_id="",
        location="",
        credentials_path=None,
        vertex_model="",
        thinking_budget=0,
        api_key=key,
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        model=model,
        reasoning_effort=LlmReasoningEffort.MINIMAL,
        max_tokens=2048,
        request_timeout_secs=45,
        on_attempt=record,
    )
    business = "סטודיו צבע" if scenario.get("otherTenant") else "OrOn"
    catalog: dict[str, Any] = (
        {
            "businessDescription": "סטודיו לאמנות",
            "productsAndServices": ["שיעורי ציור", "סדנאות קרמיקה"],
        }
        if scenario.get("otherTenant")
        else instructions["catalog"]
    )
    profile = TenantSupportProfile(
        displayName=business,
        supportDisplayName=business,
        businessDescription=catalog["businessDescription"],
        productsAndServices=catalog["productsAndServices"],
    )
    prompt = compile_voice_runtime_prompt(
        profile, agent_prompt=instructions["prompt"], persona_gender="female"
    )
    if scenario.get("verifiedPhone"):
        prompt += (
            "\nVerified transport callback number (not a supplied personal name): "
            + scenario["verifiedPhone"]
        )
    messages = [{"role": "system", "content": prompt}]
    replies, actions, failures, callers = [], [], [], []
    guard = BusinessClaimGuardFilter(
        get_language=lambda: "he",
        save_claim_receipted=turns.receipt_for_current_turn,
        finalized_claim_receipted=turns.finalized_for_current_turn,
        lead_write_failed=turns.failed_turn_key,
    )
    try:
        for caller in scenario["turns"]:
            turns.accept()
            callers.append(caller)
            messages.append({"role": "user", "content": caller})
            route = classify_turn(caller).route
            if route:
                reply = approved_response(
                    "pause" if repeated_scope_redirect(callers) else route, "he", business
                )
                replies.append(reply)
                messages.append({"role": "assistant", "content": reply})
                continue
            for _ in range(6):
                message = await completion(
                    llm,
                    messages,
                    ToolsSchema(
                        [
                            FunctionSchema(
                                name=d.name,
                                description=d.description,
                                properties=d.properties,
                                required=d.required,
                            )
                            for d in tools.descriptors
                        ]
                    ),
                )
                messages.append(message)
                # The live adapter speaks text chunks even when the same model
                # turn also calls tools. Apply the boundary before those tools
                # commit, so a later receipt cannot license an earlier claim.
                if message.get("content"):
                    replies.append(await guard.filter(message["content"]))
                if not message.get("tool_calls"):
                    break
                for call in message["tool_calls"]:
                    actions.append(call["function"]["name"])
                    result = await tools.run(
                        call["function"]["name"], json.loads(call["function"]["arguments"])
                    )
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call["id"],
                            "content": json.dumps(result, ensure_ascii=False),
                        }
                    )
            else:
                failures.append("tool budget exhausted without customer response")
        text = "\n".join(replies)
        if scenario.get("mustMention") and not re.search(scenario["mustMention"], text, re.I):
            failures.append("required relevant answer absent")
        if scenario.get("forbidFinal") and store.finals:
            failures.append("premature finalization")
        if scenario.get("requireFinal") and store.finals != 1:
            failures.append("missing finalization")
        if store.finals > 1:
            failures.append("duplicate finalization")
        if scenario.get("forbidFields") and store.fields:
            failures.append("unjustified field collection")
        if scenario.get("forbidContactQuestion") and re.search(
            r"(?:מה|איך)[^\n?]{0,15}(?:שמ[ךכ]|קוראים)|(?:מה|איזה|באיזה)[^\n?]{0,20}(?:טלפון|מספר).*\?",
            text,
        ):
            failures.append("premature/repeated contact question")
        if scenario.get("forbidPrice") and re.search(r"[0-9]+\s*(?:₪|שקלים|ש״ח|דולר)", text):
            failures.append("invented price")
        for expected, field in (("expectName", "contact_name"), ("expectPhone", "contact_phone")):
            if (
                expected in scenario
                and store.fields.get(field, {}).get("normalizedValue") != scenario[expected]
            ):
                failures.append(field + " not stored/corrected")
        if (
            scenario.get("forbidPhone")
            and store.fields.get("contact_phone", {}).get("normalizedValue") is not None
        ):
            failures.append("partial phone stored")
        if scenario.get("forbidOrOn") and re.search(r"Or.?On|אור.?און", text, re.I):
            failures.append("cross tenant identity")
        if scenario.get("failSave") and re.search("נפתח ליד|הפרטים נשמרו", text):
            failures.append("false save claim")
    except Exception as error:
        failures.append(str(error).replace(key, "[REDACTED]")[:500])
    finally:
        assert isinstance(llm, OpenAILLMService)
        await llm._client.close()
    return {
        "model": model,
        "id": scenario["id"],
        "failures": failures,
        "replies": replies,
        "actions": actions,
        "fields": list(store.fields.values()),
        "finals": store.finals,
        "attempts": attempts,
        "transcript": messages[1:],
    }


async def main():
    logger.remove()
    logger.add(sys.stderr, level="WARNING")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-provider-evals", action="store_true")
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.allow_provider_evals:
        parser.error("Explicit provider evaluation opt-in required")
    key = dotenv_values(args.env_file).get("LLM_API_KEY")
    if not key:
        parser.error("Explicit evaluation credential required")
    instructions = json.loads((args.output / "voice-instructions.json").read_text(encoding="utf8"))
    corpus = json.loads(
        (ROOT / "db/contracts/service-discovery-scenarios.v1.json").read_text(encoding="utf8")
    )
    results = []
    environment = {
        "python": sys.version,
        "platform": platform.platform(),
        "compiledInstructions": instructions.get("environment"),
        "sourceHashes": {
            path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
            for path in (
                "packages/py/oron-agent/src/oron_agent/llm.py",
                "packages/py/oron-agent/src/oron_agent/lead_capture.py",
                "packages/py/oron-agent/src/oron_agent/spoken_safety.py",
                "services/py/dispatcher/src/dispatcher_runtime/support_context.py",
            )
        },
    }
    for model in ("gemini-3.5-flash-lite", "gemini-3.1-flash-lite"):
        for scenario in corpus["scenarios"]:
            result = await scenario_run(model, key, scenario, instructions)
            results.append(result)
            (args.output / "voice.json").write_text(
                json.dumps(
                    {
                        "kind": (
                            "Real streaming voice model adapter and lead tools; "
                            "synthetic persistence, no audio or transport acceptance"
                        ),
                        "promptSha256": hashlib.sha256(instructions["prompt"].encode()).hexdigest(),
                        "environment": environment,
                        "results": results,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf8",
            )
            print(model, scenario["id"], result["failures"] or "PASS", flush=True)
    return int(any(result["failures"] for result in results))


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
