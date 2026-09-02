import pytest
from oron_tenancy.config import SipSettings, build_sip_provisioner
from oron_tenancy.provisioner import LiveKitSipProvisioner


class _FakeSip:
    """Records the SIP admin calls the provisioner makes.

    Starts with the inbound trunk already present (named "oron-inbound", the
    default the provisioner resolves by), since the id is no longer configured —
    the provisioner looks the trunk up by name on every operation.
    """

    def __init__(self, trunks=None):
        from livekit import api

        self._api = api
        # {name: id}
        self.trunks = {"oron-inbound": "ST_in"} if trunks is None else dict(trunks)
        self.created = []
        self.deleted = []
        self.created_trunks = []

    async def list_sip_inbound_trunk(self, req):
        wanted = set(req.trunk_ids)
        items = [
            self._api.SIPInboundTrunkInfo(sip_trunk_id=tid, name=name)
            for name, tid in self.trunks.items()
            if not wanted or tid in wanted
        ]
        return self._api.ListSIPInboundTrunkResponse(items=items)

    async def create_sip_inbound_trunk(self, req):
        self.created_trunks.append(req)
        new_id = f"ST_new{len(self.created_trunks)}"
        self.trunks[req.trunk.name] = new_id
        return self._api.SIPInboundTrunkInfo(sip_trunk_id=new_id, name=req.trunk.name)

    async def create_sip_dispatch_rule(self, req):
        self.created.append(req)
        return type("Info", (), {"sip_dispatch_rule_id": "SDR_new"})()

    async def delete_sip_dispatch_rule(self, req):
        self.deleted.append(req.sip_dispatch_rule_id)


class _FakeLkApi:
    def __init__(self, *a, sip=None, **k):
        self.sip = sip if sip is not None else _FakeSip()

    async def aclose(self):
        pass


def _provisioner(sip, **kw):
    """A provisioner over a single shared `_FakeSip`, so trunk and rule state
    persists across the calls a test makes."""
    return LiveKitSipProvisioner(
        url="ws://lk",
        api_key="k",
        api_secret="s",
        api_factory=lambda *a, **k: _FakeLkApi(sip=sip),
        **kw,
    )


async def test_provision_resolves_the_trunk_by_name_and_scopes_the_rule_to_the_did():
    sip = _FakeSip()  # trunk "oron-inbound" -> "ST_in"
    p = _provisioner(sip, room_prefix="call-")
    rule_id = await p.provision_did("+14155550100")

    assert rule_id == "SDR_new"
    req = sip.created[0]

    # Everything must land inside the nested `dispatch_rule`: LiveKit ignores the
    # deprecated top-level fields entirely once `dispatch_rule` is set, so a field
    # left at the top level would be silently dropped.
    rule = req.dispatch_rule
    # `numbers` = the called number (our DID). `inbound_numbers` would scope on the
    # *caller's* number instead — the inversion that made real inbound calls match
    # no rule and get rejected.
    assert list(rule.numbers) == ["+14155550100"]  # scoped to this DID only
    assert list(rule.inbound_numbers) == []  # must NOT filter on the caller
    assert rule.name == "oron-did-+14155550100"
    assert list(rule.trunk_ids) == ["ST_in"]  # the id resolved from the name
    assert rule.rule.dispatch_rule_individual.room_prefix == "call-"

    # Nothing may remain on the deprecated top-level fields.
    assert list(req.trunk_ids) == []
    assert list(req.inbound_numbers) == []
    assert req.name == ""


async def test_provision_re_resolves_the_trunk_every_time_and_never_caches_the_id():
    """The whole point of holding a name: if the trunk is recreated under a new id
    while we run, the next provision uses the new id, not a stale cached one."""
    sip = _FakeSip()
    p = _provisioner(sip)
    await p.provision_did("+14155550100")
    assert list(sip.created[0].dispatch_rule.trunk_ids) == ["ST_in"]

    # Trunk recreated out from under us with a different id.
    sip.trunks["oron-inbound"] = "ST_reborn"
    await p.provision_did("+14155550101")
    assert list(sip.created[1].dispatch_rule.trunk_ids) == ["ST_reborn"]


async def test_provision_raises_when_the_named_trunk_is_gone():
    """A trunk deleted between boot and this call cannot admit anything — do not
    create a rule that references nothing."""
    sip = _FakeSip(trunks={})  # no trunk at all
    p = _provisioner(sip)
    with pytest.raises(Exception):
        await p.provision_did("+14155550100")
    assert sip.created == []


async def test_deprovision_deletes_the_rule():
    sip = _FakeSip()
    p = _provisioner(sip)
    await p.deprovision_did("SDR_gone")
    assert sip.deleted == ["SDR_gone"]


async def test_list_dispatch_rules_snapshots_every_rule_on_the_server():
    """Reconciliation needs every rule, not only ours — a catch-all created by hand
    before per-DID admission existed is exactly what it has to find."""
    from livekit import api

    class _ListingSip(_FakeSip):
        async def list_sip_dispatch_rule(self, req):
            return api.ListSIPDispatchRuleResponse(
                items=[
                    api.SIPDispatchRuleInfo(
                        sip_dispatch_rule_id="SDR_1",
                        name="oron-did-+14155550100",
                        numbers=["+14155550100"],
                    ),
                    api.SIPDispatchRuleInfo(
                        sip_dispatch_rule_id="SDR_catchall", name="oron-dispatch"
                    ),
                ]
            )

    rules = await _provisioner(_ListingSip()).list_dispatch_rules()

    assert [r.id for r in rules] == ["SDR_1", "SDR_catchall"]
    assert rules[0].numbers == ["+14155550100"]
    assert rules[1].numbers == []  # the catch-all, carrying no `numbers` filter
    assert rules[1].name == "oron-dispatch"


async def test_list_dispatch_rules_can_ask_for_specific_ids():
    """Diagnosing one DID must not pull every rule on the server."""
    from livekit import api

    captured = {}

    class _ListingSip(_FakeSip):
        async def list_sip_dispatch_rule(self, req):
            captured["req"] = req
            return api.ListSIPDispatchRuleResponse(items=[])

    assert await _provisioner(_ListingSip()).list_dispatch_rules(ids=["SDR_1"]) == []
    assert list(captured["req"].dispatch_rule_ids) == ["SDR_1"]


async def test_ensure_inbound_trunk_is_a_no_op_when_the_named_trunk_is_present():
    sip = _FakeSip()  # "oron-inbound" already there
    await _provisioner(sip).ensure_inbound_trunk()
    assert sip.created_trunks == []  # nothing created — it was already there


async def test_ensure_inbound_trunk_creates_it_when_the_server_has_none():
    """The wiped-Redis case: recreate the declared trunk from config rather than
    make an operator do it by hand before the service can come up."""
    sip = _FakeSip(trunks={})
    await _provisioner(sip, inbound_trunk_allowed_addresses=["10.0.0.0/8"]).ensure_inbound_trunk()

    assert len(sip.created_trunks) == 1
    created = sip.created_trunks[0].trunk
    assert created.name == "oron-inbound"
    assert list(created.allowed_addresses) == ["10.0.0.0/8"]
    assert "oron-inbound" in sip.trunks  # and it is now resolvable


async def test_ensure_inbound_trunk_refuses_to_guess_among_foreign_trunks():
    """Trunks exist but none is ours: that is someone else's SIP configuration.
    Creating another, or adopting one, would be worse than stopping."""
    sip = _FakeSip(trunks={"someone-elses": "ST_theirs"})
    with pytest.raises(Exception):
        await _provisioner(sip).ensure_inbound_trunk()
    assert sip.created_trunks == []  # did not create, did not adopt


def test_build_returns_none_without_full_sip_config():
    # Missing LiveKit creds → no provisioner → registration will fail closed. The
    # trunk name has a default, so it is creds, not the name, that gate this.
    # The secret is passed explicitly, like the disabled case in
    # test_phone_registration: SipSettings reads `.env`, so omitting it asserts
    # nothing on a developer machine that has one.
    s = SipSettings(
        enable_real_telephony=True,
        livekit_url="ws://lk",
        livekit_api_key="k",
        livekit_api_secret=None,
    )
    assert build_sip_provisioner(s) is None


def test_build_returns_none_when_real_telephony_is_disabled():
    s = SipSettings(
        enable_real_telephony=False,
        livekit_url="ws://lk",
        livekit_api_key="k",
        livekit_api_secret="s",
    )
    assert build_sip_provisioner(s) is None


def test_sip_credentials_are_redacted_from_settings_diagnostics():
    s = SipSettings(
        livekit_url="ws://lk",
        livekit_api_key="public-ish-key",
        livekit_api_secret="never-print-this",
    )
    rendered = repr(s)
    assert "public-ish-key" not in rendered
    assert "never-print-this" not in rendered


def test_build_returns_provisioner_when_configured():
    s = SipSettings(
        enable_real_telephony=True,
        livekit_url="ws://lk",
        livekit_api_key="k",
        livekit_api_secret="s",
    )
    assert isinstance(build_sip_provisioner(s), LiveKitSipProvisioner)


async def test_a_trunk_open_to_the_world_is_refused_not_merely_warned_about():
    """Convergence creates the trunk unattended, so a warning is a warning nobody
    reads. An open trunk lets anyone who knows the host dial a tenant's DID and
    spend the account's LLM/TTS budget."""
    sip = _FakeSip(trunks={})
    with pytest.raises(RuntimeError, match="0.0.0.0/0"):
        await _provisioner(
            sip, inbound_trunk_allowed_addresses=["0.0.0.0/0"]
        ).ensure_inbound_trunk()
    assert sip.created_trunks == []


async def test_an_unconfigured_acl_is_refused_because_livekit_reads_empty_as_open():
    """An empty allowed_addresses is not 'no opinion' — LiveKit admits everyone.
    Forgetting to configure it must not be the same as opening it."""
    sip = _FakeSip(trunks={})
    with pytest.raises(RuntimeError, match="INBOUND_TRUNK_ALLOWED_ADDRESSES"):
        await _provisioner(sip, inbound_trunk_allowed_addresses=[]).ensure_inbound_trunk()
    assert sip.created_trunks == []


async def test_dev_can_open_the_trunk_deliberately_and_is_shouted_at():
    """Dev without a carrier needs a wide-open trunk; it just has to be an
    explicit act rather than the default."""
    from loguru import logger

    records: list[str] = []
    sink = logger.add(lambda m: records.append(str(m)), level="WARNING")
    try:
        sip = _FakeSip(trunks={})
        await _provisioner(
            sip,
            inbound_trunk_allowed_addresses=["0.0.0.0/0"],
            allow_any_address=True,
        ).ensure_inbound_trunk()
    finally:
        logger.remove(sink)

    assert len(sip.created_trunks) == 1
    assert any("0.0.0.0/0" in r for r in records), records


async def test_a_restricted_trunk_is_created_without_the_warning():
    from loguru import logger

    records: list[str] = []
    sink = logger.add(lambda m: records.append(str(m)), level="WARNING")
    try:
        sip = _FakeSip(trunks={})
        await _provisioner(
            sip, inbound_trunk_allowed_addresses=["192.76.120.10/32"]
        ).ensure_inbound_trunk()
    finally:
        logger.remove(sink)

    assert not any("0.0.0.0/0" in r for r in records)
