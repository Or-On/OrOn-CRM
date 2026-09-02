from oron_agent.flows.runtime import HandlerContext, HandlerRegistry, HandlerResult


async def test_handler_result_defaults():
    r = HandlerResult(route="ok")
    assert r.data == {} and r.public is None


async def test_context_carries_args_state_and_config():
    async def lookup(ctx: HandlerContext) -> HandlerResult:
        known = ctx.config["known"]
        name = ctx.args["name"]
        return HandlerResult(route="found" if name in known else "miss", data={"name": name})

    hr = HandlerRegistry(handlers={"lookup": lookup})
    ctx = HandlerContext(args={"name": "כהן"}, state={}, config={"known": ["כהן"]})
    res = await hr.handlers["lookup"](ctx)
    assert res.route == "found" and res.data["name"] == "כהן"


async def test_args_default_empty_for_node_entry():
    """On entry there is no function call, so a handler sees no args."""
    assert HandlerContext(state={}).args == {}
