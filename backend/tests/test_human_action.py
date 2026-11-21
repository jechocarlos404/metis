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
        # Seed files carry a product's technology uses; no screen records them.
        ("/api/stacks/usage", "/settings#seed-files"),
        # /stacks only binds a slot, so only binding is sent there.
        (f"/api/stacks/slots/{ID}/bind", f"/stacks?slot={ID}"),
        ("/api/stacks", "/ontology"),
        (f"/api/stacks/slots/{ID}", "/ontology"),
        (f"/api/stacks/{ID}/concerns", "/ontology"),
        ("/api/constraints", "/ontology"),
        # The one technology write a screen makes (the form is on /tech/{slug};
        # the path names no technology, so the catalog opens).
        ("/api/tech/encounters", "/tech"),
        (f"/api/tech/encounters/{ID}", "/tech"),
        # Seed files carry technologies and what they satisfy; no screen does.
        ("/api/tech", "/settings#seed-files"),
        ("/api/tech/qdrant", "/settings#seed-files"),
        (f"/api/tech/satisfactions/{ID}", "/settings#seed-files"),
        # Versions, vendors, links and stance: the API only.
        ("/api/tech/qdrant/adoption", "/ontology"),
        ("/api/tech/qdrant/versions", "/ontology"),
        (f"/api/tech/versions/{ID}", "/ontology"),
        ("/api/tech/vendors", "/ontology"),
        (f"/api/tech/edges/{ID}", "/ontology"),
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


@pytest.mark.parametrize(
    "path",
    [
        "/api/stacks",
        "/api/stacks/instantiate",
        f"/api/stacks/{ID}",
        f"/api/stacks/{ID}/slots",
        f"/api/stacks/slots/{ID}",
        f"/api/stacks/{ID}/concerns/{ID}",
    ],
)
def test_a_stack_write_no_screen_makes_says_so(path):
    message, href = human_action(path)
    assert message == (
        "No screen creates or changes a stack, and seed files don't carry one: "
        "a person with editor access records it through metis's API."
    )
    assert href == "/ontology"


def test_technology_uses_point_at_seed_files_and_constraints_name_no_stack():
    message, _ = human_action("/api/stacks/usage")
    assert message.startswith("No screen records which technologies a product uses: a seed file")
    message, _ = human_action(f"/api/concerns/{ID}")
    assert "stack" not in message and message.startswith("No screen records constraints")


def test_a_technology_write_no_screen_makes_says_so():
    """R-W5 for technologies (D44): only an encounter has a form; the refusal
    says where the rest come from rather than opening /tech, which can't."""
    for path in ("/api/tech", "/api/tech/qdrant", "/api/tech/satisfactions"):
        assert human_action(path) == (
            "No screen records a technology or the capabilities it satisfies: a seed file "
            "carries them, or a person with editor access records them through metis's API.",
            "/settings#seed-files",
        )
    for path in ("/api/tech/qdrant/versions", "/api/tech/qdrant/adoption", "/api/tech/vendors",
                 f"/api/tech/vendors/{ID}", "/api/tech/edges", f"/api/tech/versions/{ID}"):
        message, href = human_action(path)
        assert message.startswith("No screen records a technology's versions, vendor, links")
        assert "seed files don't carry them" in message and href == "/ontology"
    message, href = human_action("/api/tech/encounters")
    assert message.startswith("This is a human action") and href == "/tech"
    model = (PAGES.parents[2] / "backend" / "app" / "ontology" / "model.md").read_text()
    assert "A technology's versions, vendor, links to other technologies and the group's stance" in model


def test_binding_still_goes_to_the_slot():
    assert human_action(f"/api/stacks/slots/{ID}/bind") == (
        "Binding a slot is a human action.",
        f"/stacks?slot={ID}",
    )
