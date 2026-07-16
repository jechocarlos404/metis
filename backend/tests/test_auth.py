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

from app.auth import Principal, authorize
from app.auth.deps import require_admin
from app.auth.jwt import TokenVerifier
from app.config import Settings


def _p(*roles: str) -> Principal:
    return Principal(sub="u", username="u", roles=list(roles))


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
