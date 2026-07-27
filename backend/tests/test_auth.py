"""Auth boundary tests: the RBAC decision matrix and RS256 token validation.

These exercise the security logic directly (the existing suite calls services,
not HTTP, so router gating doesn't affect it). Live HTTP wiring is covered by
the end-to-end browser verification.
"""

import time

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

from app.auth import Principal, authorize, surface_from_azp
from app.auth.deps import require_admin
from app.auth.jwt import TokenVerifier, principal_from_claims
from app.config import Settings
from app.models.enums import Surface


def _p(*roles: str, surface: Surface = Surface.desktop) -> Principal:
    return Principal(sub="u", username="u", roles=list(roles), surface=surface)


# --- RBAC decision matrix (pure) ---------------------------------------------

@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
def test_reads_allowed_for_viewer(method):
    authorize(method, _p("viewer"))  # does not raise


@pytest.mark.parametrize("method", ["POST", "PATCH", "PUT", "DELETE"])
def test_writes_blocked_for_viewer(method):
    with pytest.raises(HTTPException) as err:
        authorize(method, _p("viewer"))
    assert err.value.status_code == 403


@pytest.mark.parametrize("role", ["editor", "admin"])
@pytest.mark.parametrize("method", ["POST", "DELETE"])
def test_writes_allowed_for_editor_and_admin(role, method):
    authorize(method, _p(role))  # does not raise


# --- the write boundary: only the desktop writes -----------------------------

@pytest.mark.parametrize("surface", [Surface.api, Surface.mcp])
@pytest.mark.parametrize("method", ["POST", "PATCH", "PUT", "DELETE"])
def test_writes_blocked_off_desktop_even_for_admin(surface, method):
    """An agent that can bind a slot can silence a gap, and the gaps are the
    product. Role is not the gate here — the door is."""
    with pytest.raises(HTTPException) as err:
        authorize(method, _p("admin", surface=surface), "/api/stacks/slots/abc/bind")
    assert err.value.status_code == 403
    assert err.value.detail["error"] == "human_action_required"
    # The refusal hands over the screen that can do it.
    assert err.value.detail["href"] == "/stacks?slot=abc"


@pytest.mark.parametrize("surface", [Surface.api, Surface.mcp])
def test_reads_allowed_off_desktop(surface):
    authorize("GET", _p("viewer", surface=surface), "/api/tech")  # does not raise


@pytest.mark.parametrize("surface", [Surface.api, Surface.mcp])
def test_recommend_is_a_read_despite_being_a_post(surface):
    """POST because the input is a body, not because it writes. Nothing is
    persisted; the response is an argument."""
    authorize("POST", _p("viewer", surface=surface), "/api/stacks/metis/recommend")


@pytest.mark.parametrize(
    "path",
    [
        "/api/stacks/slots/abc/bind/recommend",  # suffix match would exempt this
        "/api/stacks/a/b/recommend",
        "/api/tech/recommend",
        "/api/recommend",
    ],
)
def test_the_read_by_post_exemption_does_not_widen(path):
    """The path is caller-controlled, so the exemption matches in full. An
    exemption that widens by accident gets discovered rather than reviewed."""
    with pytest.raises(HTTPException):
        authorize("POST", _p("viewer", surface=Surface.api), path)


def test_viewer_on_desktop_hears_about_their_role_not_their_surface():
    with pytest.raises(HTTPException) as err:
        authorize("POST", _p("viewer"), "/api/stacks/slots/abc/bind")
    assert err.value.detail == "Requires editor or admin role"


# --- surface comes from the signed azp, not from a header --------------------

def test_surface_derives_from_the_authorized_party():
    assert surface_from_azp("metis-web", "metis-web", "metis-mcp") is Surface.desktop
    assert surface_from_azp("metis-mcp", "metis-web", "metis-mcp") is Surface.mcp
    assert surface_from_azp("some-script", "metis-web", "metis-mcp") is Surface.api
    # An absent azp gets the least-privileged surface, never the desktop.
    assert surface_from_azp(None, "metis-web", "metis-mcp") is Surface.api


def test_principal_defaults_to_api_when_no_client_configured():
    principal = principal_from_claims({"sub": "u", "azp": "metis-web"})
    assert principal.surface is Surface.api


@pytest.mark.asyncio
async def test_require_admin_allows_admin():
    principal = await require_admin(_p("admin"))
    assert principal.has_role("admin")


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["editor", "viewer"])
async def test_require_admin_blocks_non_admin(role):
    with pytest.raises(HTTPException) as err:
        await require_admin(_p(role))
    assert err.value.status_code == 403


# --- Token validation (real RS256, stubbed JWKS) -----------------------------

ISSUER = "http://kc/realms/metis"
AUDIENCE = "metis-backend"


@pytest.fixture(scope="module")
def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def verifier(rsa_key, monkeypatch):
    settings = Settings(
        keycloak_issuer=ISSUER,
        keycloak_audience=AUDIENCE,
        keycloak_internal_url="http://kc",
        keycloak_realm="metis",
    )
    v = TokenVerifier(settings)
    public = rsa_key.public_key()
    monkeypatch.setattr(
        v._jwks, "get_signing_key_from_jwt", lambda token: type("K", (), {"key": public})
    )
    return v


def _token(rsa_key, **overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": "abc",
        "preferred_username": "alice",
        "email": "alice@metis.local",
        "name": "Alice",
        "iss": ISSUER,
        "aud": AUDIENCE,
        "iat": now,
        "exp": now + 300,
        "realm_access": {"roles": ["editor"]},
    }
    claims.update(overrides)
    return pyjwt.encode(claims, rsa_key, algorithm="RS256")


def test_verify_valid_token(verifier, rsa_key):
    principal = verifier.verify(_token(rsa_key))
    assert principal.username == "alice"
    assert principal.email == "alice@metis.local"
    assert principal.has_role("editor")


def test_verify_rejects_wrong_audience(verifier, rsa_key):
    with pytest.raises(HTTPException) as err:
        verifier.verify(_token(rsa_key, aud="another-client"))
    assert err.value.status_code == 401


def test_verify_rejects_wrong_issuer(verifier, rsa_key):
    with pytest.raises(HTTPException) as err:
        verifier.verify(_token(rsa_key, iss="http://evil/realms/metis"))
    assert err.value.status_code == 401


def test_verify_rejects_expired(verifier, rsa_key):
    with pytest.raises(HTTPException) as err:
        verifier.verify(_token(rsa_key, exp=int(time.time()) - 10))
    assert err.value.status_code == 401
