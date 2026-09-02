"""Bring LiveKit's SIP admission back in line with the registered numbers."""

from loguru import logger
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from oron_tenancy.models import PhoneNumber
from oron_tenancy.provisioner import SipProvisioner
from oron_tenancy.reconcile import Finding, RegisteredNumber, RuleIssue, reconcile

# Without this, concurrent boots each provision a rule for the same DID.
_CONVERGENCE_LOCK_KEY = int.from_bytes(b"oron-sip", "big", signed=True)


class SipAdmissionUnavailable(RuntimeError):
    """Nothing we could provision would admit a call; fails startup deliberately."""


class ConvergenceResult(BaseModel):
    """What boot found and what it did about it."""

    repaired: list[str] = []
    unrepairable: list[str] = []
    reported: list[Finding] = []
    skipped_locked: bool = False

    @property
    def ok(self) -> bool:
        return not (self.repaired or self.unrepairable or self.reported)


async def repoint(number: PhoneNumber, provisioner: SipProvisioner, db: AsyncSession) -> str:
    """Provision a fresh rule for `number` and point its row at it.

    The stale rule is left alone: on a mismatch it may be the only thing
    admitting some other live number.
    """
    rule_id = await provisioner.provision_did(number.e164)
    stale = number.dispatch_rule_id
    number.dispatch_rule_id = rule_id
    await db.flush()
    logger.info(
        f"repaired SIP admission with rule {rule_id} "
        f"(previous rule {stale} left for reconciliation)"
    )
    return rule_id


async def converge_sip_admission(
    *, provisioner: SipProvisioner, sessionmaker: async_sessionmaker[AsyncSession]
) -> ConvergenceResult:
    """Reconcile, then repair what is ours to repair.

    Raises SipAdmissionUnavailable on systemic faults. A single unrepairable
    number is recorded, not raised — one bad DID must not take the API down.
    """
    try:
        # Rules hang off the trunk, so it must exist before provisioning any.
        await provisioner.ensure_inbound_trunk()
        rules = await provisioner.list_dispatch_rules()
    except Exception as exc:
        raise SipAdmissionUnavailable(
            f"SIP admission could not be established ({type(exc).__name__})"
        ) from exc

    result = ConvergenceResult()
    async with sessionmaker() as db, db.begin():
        locked = await db.scalar(select(func.pg_try_advisory_xact_lock(_CONVERGENCE_LOCK_KEY)))
        if not locked:
            logger.info("another replica is converging SIP admission; skipping")
            return ConvergenceResult(skipped_locked=True)

        rows = (await db.execute(select(PhoneNumber))).scalars().all()
        by_e164 = {r.e164: r for r in rows}
        report = reconcile(
            rules=rules,
            registered=[
                RegisteredNumber(e164=r.e164, dispatch_rule_id=r.dispatch_rule_id) for r in rows
            ],
        )

        for finding in report.findings:
            # Findings naming no row we know are reported, never guessed at.
            repairable = finding.issue in (RuleIssue.missing, RuleIssue.mismatched)
            number = by_e164.get(finding.e164) if finding.e164 else None
            if not repairable or number is None:
                logger.error(
                    f"SIP admission needs attention: issue={finding.issue} "
                    f"rule={finding.dispatch_rule_id or 'none'}"
                )
                result.reported.append(finding)
                continue

            logger.warning(
                f"converging SIP admission: issue={finding.issue} "
                f"rule={finding.dispatch_rule_id or 'none'}"
            )
            try:
                await repoint(number, provisioner, db)
                result.repaired.append(number.e164)
            except Exception as exc:
                logger.error(f"could not re-provision SIP admission ({type(exc).__name__})")
                result.unrepairable.append(number.e164)

    if result.ok:
        logger.info("SIP admission is consistent with the registered numbers")
    return result
