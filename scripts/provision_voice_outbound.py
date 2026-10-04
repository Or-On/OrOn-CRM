"""Review a tenant's existing carrier binding; mutate only with explicit --apply.

This provisions an outbound LiveKit trunk only. It never dials, changes inbound
routing, modifies another carrier trunk, changes a credential, or activates the
dispatcher. Run the dry plan first and obtain the infrastructure authorization.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path
from uuid import UUID

import httpx
from dotenv import dotenv_values
from livekit import api
from pydantic import BaseModel, ConfigDict, Field


class OutboundProvisionPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    tenant_id: UUID
    account_ref: str = Field(pattern=r"^[a-zA-Z0-9_.:-]+$")
    from_number: str = Field(pattern=r"^\+[1-9][0-9]{7,14}$")
    twilio_trunk_id: str = Field(pattern=r"^TK[0-9a-f]{32}$")
    credential_list_id: str = Field(pattern=r"^CL[0-9a-f]{32}$")
    address: str = Field(pattern=r"^[a-z0-9-]+\.pstn\.twilio\.com$")
    sip_username: str = Field(min_length=1, max_length=120)
    livekit_trunk_name: str = Field(min_length=1, max_length=120)


def required(values: dict, key: str) -> str:
    value = values.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"required private configuration key is absent: {key}")
    return value


class Carrier:
    def __init__(self, account: str, token: str):
        self.account = account
        self.client = httpx.AsyncClient(auth=(account, token), timeout=20)

    async def request(self, path: str, *, fields: dict | None = None):
        response = await self.client.request("GET" if fields is None else "POST", path, data=fields)
        response.raise_for_status()
        return response.json()

    async def inspect(self, plan: OutboundProvisionPlan) -> dict:
        base = f"https://trunking.twilio.com/v1/Trunks/{plan.twilio_trunk_id}"
        trunk = await self.request(base)
        numbers = await self.request(f"{base}/PhoneNumbers?PageSize=100")
        lists = await self.request(f"{base}/CredentialLists?PageSize=100")
        credentials = await self.request(
            f"https://api.twilio.com/2010-04-01/Accounts/{self.account}/SIP/"
            f"CredentialLists/{plan.credential_list_id}/Credentials.json?PageSize=100"
        )
        if trunk.get("account_sid") != self.account:
            raise ValueError("carrier trunk does not belong to configured account")
        if not any(n.get("phone_number") == plan.from_number for n in numbers["phone_numbers"]):
            raise ValueError("sender is not owned by the planned carrier trunk")
        if not any(c.get("username") == plan.sip_username for c in credentials["credentials"]):
            raise ValueError("planned SIP username is absent from the existing credential list")
        if trunk.get("domain_name") not in (None, "", plan.address):
            raise ValueError("carrier termination endpoint changed; review a new plan")
        return {
            "domain": trunk.get("domain_name"),
            "credential_associated": any(
                item.get("sid") == plan.credential_list_id for item in lists["credential_lists"]
            ),
        }

    async def set_domain(self, plan: OutboundProvisionPlan):
        await self.request(
            f"https://trunking.twilio.com/v1/Trunks/{plan.twilio_trunk_id}",
            fields={"DomainName": plan.address},
        )

    async def associate_credentials(self, plan: OutboundProvisionPlan):
        await self.request(
            f"https://trunking.twilio.com/v1/Trunks/{plan.twilio_trunk_id}/CredentialLists",
            fields={"CredentialListSid": plan.credential_list_id},
        )


async def review_or_apply(plan, carrier, sip, *, password: str, apply: bool, receipt: Path):
    """Preflight all read-only bindings before the first provider mutation."""
    state = await carrier.inspect(plan)
    inventory = await sip.list_outbound_trunk(api.ListSIPOutboundTrunkRequest())
    existing = [t for t in inventory.items if t.name == plan.livekit_trunk_name]
    if len(existing) > 1:
        raise ValueError("multiple LiveKit trunks have the planned name")
    if existing and (
        existing[0].address != plan.address
        or list(existing[0].numbers) != [plan.from_number]
        or existing[0].auth_username != plan.sip_username
    ):
        raise ValueError("existing LiveKit trunk differs from reviewed binding")
    changes = []
    if state["domain"] != plan.address:
        changes.append("set termination domain on the planned carrier trunk")
    if not state["credential_associated"]:
        changes.append("associate the existing credential list with the planned carrier trunk")
    if not existing:
        changes.append("create a separate LiveKit outbound trunk for the single planned sender")
    summary = {
        "mode": "apply" if apply else "review_only",
        "tenant_id": str(plan.tenant_id),
        "account_ref": plan.account_ref,
        "from_masked": "***" + plan.from_number[-4:],
        "carrier_trunk": plan.twilio_trunk_id,
        "address": plan.address,
        "changes": changes,
        "dial_performed": False,
    }
    if not apply:
        return summary
    identity = hashlib.sha256(plan.model_dump_json().encode()).hexdigest()
    recorded = {"plan_sha256": identity, "original": state, "completed": []}
    if await asyncio.to_thread(receipt.exists):
        recorded = json.loads(await asyncio.to_thread(receipt.read_text, encoding="utf-8"))
        if recorded.get("plan_sha256") != identity:
            raise ValueError("receipt belongs to a different reviewed plan")

    def checkpoint(step: str):
        if step not in recorded["completed"]:
            recorded["completed"].append(step)
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text(json.dumps(recorded, indent=2), encoding="utf-8")

    checkpoint("preflight")
    if state["domain"] != plan.address:
        await carrier.set_domain(plan)
        checkpoint("carrier_domain")
    if not state["credential_associated"]:
        await carrier.associate_credentials(plan)
        checkpoint("credential_association")
    if existing:
        trunk = existing[0]
    else:
        trunk = await sip.create_outbound_trunk(
            api.CreateSIPOutboundTrunkRequest(
                trunk=api.SIPOutboundTrunkInfo(
                    name=plan.livekit_trunk_name,
                    address=plan.address,
                    numbers=[plan.from_number],
                    auth_username=plan.sip_username,
                    auth_password=password,
                )
            )
        )
    recorded["route"] = {
        "tenant_id": str(plan.tenant_id),
        "account_ref": plan.account_ref,
        "trunk_id": trunk.sip_trunk_id,
        "from_number": plan.from_number,
        "address": plan.address,
    }
    checkpoint("livekit_outbound_trunk")
    return {**summary, "trunk_id": trunk.sip_trunk_id, "receipt": str(receipt)}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--provider-env", type=Path, required=True)
    parser.add_argument("--livekit-env", type=Path, default=Path(".env"))
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    carrier = None
    livekit = None
    try:
        plan = OutboundProvisionPlan.model_validate_json(args.plan.read_text(encoding="utf-8"))
        private = dotenv_values(args.provider_env)
        shared = dotenv_values(args.livekit_env)
        if required(private, "TWILIO_SIP_USERNAME") != plan.sip_username:
            raise ValueError("private SIP username does not match reviewed plan")
        carrier = Carrier(
            required(private, "TWILIO_ACCOUNT_SID"), required(private, "TWILIO_AUTH_TOKEN")
        )
        livekit = api.LiveKitAPI(
            required(shared, "LIVEKIT_URL"),
            required(shared, "LIVEKIT_API_KEY"),
            required(shared, "LIVEKIT_API_SECRET"),
        )
        result = await review_or_apply(
            plan,
            carrier,
            livekit.sip,
            password=required(private, "TWILIO_SIP_PASSWORD"),
            apply=args.apply,
            receipt=args.receipt,
        )
        print(json.dumps(result, indent=2))
    except Exception as error:
        # Provider responses/config validation may contain private input.
        print(
            json.dumps(
                {
                    "result": "failed",
                    "error_type": type(error).__name__,
                    "status": getattr(getattr(error, "response", None), "status_code", None),
                }
            )
        )
        return 1
    finally:
        if carrier is not None:
            await carrier.client.aclose()
        if livekit is not None:
            await livekit.aclose()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
