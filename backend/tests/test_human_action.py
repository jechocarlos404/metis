"""A write refused off the desktop hands over the screen that can make it.

The href is the whole point of the refusal: an agent relays it to a person, so
it has to be a page that exists, not the API path with `/api` cut off.
"""

import re
from pathlib import Path

import pytest

from app.auth import Principal, authorize
from app.auth.deps import human_action
from app.main import create_app
from app.models.enums import Surface

PAGES = Path(__file__).resolve().parents[2] / "frontend" / "src" / "pages"
ID = "61e69724-0000-4000-8000-000000000001"


def _page_exists(href: str) -> bool:
    path = re.split(r"[?#]", href)[0].strip("/")
    if (PAGES / f"{path}.astro").exists() or (PAGES / path / "index.astro").exists():
        return True
    parent, _, _ = path.rpartition("/")
    folder = PAGES / parent
    # A dynamic page, e.g. capabilities/[slug].astro or tech/[slug].astro.
    return bool(parent) and folder.is_dir() and any(
        p.name.startswith("[") and p.suffix == ".astro" for p in folder.iterdir()
    )


def _write_paths():
    for path, ops in create_app().openapi()["paths"].items():
        if any(m.upper() not in ("GET", "HEAD", "OPTIONS") for m in ops):
            yield re.sub(r"\{(slug|agent_name)\}", "qdrant", re.sub(r"\{\w+_id\}", ID, path))


@pytest.mark.parametrize("path", sorted(set(_write_paths())))
def test_every_write_refusal_opens_a_screen_that_exists(path):
    _, href = human_action(path)
    assert not href.startswith("/api"), href
    assert _page_exists(href), f"{path} → {href}"


@pytest.mark.parametrize(
    "path,href",
    [
        (f"/api/capabilities/{ID}", "/capabilities"),
        (f"/api/capabilities/{ID}/motivations", "/capabilities"),
        (f"/api/features/{ID}", f"/features?feature={ID}"),
        (f"/api/features/edges/{ID}", "/features"),
        (f"/api/products/{ID}", f"/products?product={ID}"),
        (f"/api/products/{ID}/seeded", "/settings#seed-files"),
        (f"/api/goals/{ID}", f"/goals?goal={ID}"),
        (f"/api/journeys/{ID}", f"/journeys?id={ID}"),
        ("/api/guesses", "/settings#seed-files"),
        (f"/api/guesses/{ID}/confirm", "/features"),
        ("/api/graph/refresh", "/features"),
        ("/api/stacks/usage", "/stacks"),
        (f"/api/stacks/slots/{ID}/bind", f"/stacks?slot={ID}"),
        ("/api/tech/qdrant/adoption", "/tech/qdrant"),
        (f"/api/tech/satisfactions/{ID}", "/tech"),
        # Something not shaped like an id doesn't ride along into the href.
        ("/api/features/a%2Fb", "/features"),
    ],
)
def test_the_screen_is_the_one_that_does_it(path, href):
    with pytest.raises(Exception) as err:
        authorize(
            "DELETE", Principal(sub="m", username="m", roles=["admin"], surface=Surface.mcp), path
        )
    assert err.value.status_code == 403
    assert err.value.detail["href"] == href


def test_the_seed_files_anchor_exists():
    island = PAGES.parent / "components" / "islands" / "SettingsIsland.jsx"
    assert 'id="seed-files"' in island.read_text()
