from app.llm.base import LiveModelCache, order_models
from app.llm.openai_compat import OpenAICompatProvider


def test_order_models_puts_curated_first_then_rest_sorted():
    assert order_models(["b", "z"], ["c", "a", "b"]) == ["b", "a", "c"]


def test_order_models_drops_curated_entries_missing_from_live_list():
    assert order_models(["gone"], ["y", "x"]) == ["x", "y"]


async def test_live_model_cache_remembers_failures_within_ttl():
    calls = 0

    async def fetch():
        nonlocal calls
        calls += 1
        raise RuntimeError("boom")

    cache = LiveModelCache(ttl=1000)
    assert await cache.get(fetch) is None
    assert await cache.get(fetch) is None
    assert calls == 1


async def test_detect_uses_live_models_when_listing_succeeds():
    provider = OpenAICompatProvider(
        "openai",
        "OpenAI API",
        api_key_getter=lambda: "sk-test",
        models_getter=lambda: ["gpt-5.1"],
    )

    async def fake_fetch():
        return ["gpt-4.1", "gpt-5.1", "gpt-5.1-mini"]

    provider._fetch_models = fake_fetch
    status = await provider.detect()
    assert status.available is True
    assert status.models == ["gpt-5.1", "gpt-4.1", "gpt-5.1-mini"]


async def test_detect_falls_back_to_catalog_when_listing_fails():
    provider = OpenAICompatProvider(
        "openai",
        "OpenAI API",
        api_key_getter=lambda: "sk-test",
        models_getter=lambda: ["gpt-5.1"],
    )

    async def failing_fetch():
        raise RuntimeError("network down")

    provider._fetch_models = failing_fetch
    status = await provider.detect()
    assert status.available is True
    assert status.models == ["gpt-5.1"]


async def test_detect_skips_live_listing_without_credentials():
    async def must_not_run():
        raise AssertionError("should not fetch models without a key")

    provider = OpenAICompatProvider(
        "openai",
        "OpenAI API",
        api_key_getter=lambda: "",
        models_getter=lambda: ["gpt-5.1"],
    )
    provider._fetch_models = must_not_run
    status = await provider.detect()
    assert status.available is False
    assert status.models == ["gpt-5.1"]
