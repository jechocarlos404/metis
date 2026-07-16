"""Keycloak access-token validation.

Verifies RS256 tokens against the realm JWKS (signature + issuer + audience +
expiry) and projects the claims into a small `Principal`. The audience check
relies on the realm's audience mapper adding `metis-backend` to the token `aud`.
"""

from dataclasses import dataclass, field

import jwt
from fastapi import HTTPException, status
from jwt import PyJWKClient

from app.config import Settings


@dataclass
class Principal:
    sub: str
    username: str
    email: str | None = None
    name: str | None = None
    roles: list[str] = field(default_factory=list)

    def has_role(self, role: str) -> bool:
        return role in self.roles

    def has_any(self, *roles: str) -> bool:
        return any(r in self.roles for r in roles)


class TokenVerifier:
    """Caches the realm signing keys and validates access tokens."""

    def __init__(self, settings: Settings):
        self.issuer = settings.keycloak_issuer.rstrip("/")
        self.audience = settings.keycloak_audience
        jwks_url = (
            f"{settings.keycloak_internal_url.rstrip('/')}"
            f"/realms/{settings.keycloak_realm}/protocol/openid-connect/certs"
        )
        # Constructing the client does no I/O — keys are fetched lazily on the
        # first token and cached (refreshed on an unknown kid).
        self._jwks = PyJWKClient(jwks_url, cache_keys=True)

    def verify(self, token: str) -> Principal:
        """Return the Principal for a valid token, else raise 401. Synchronous
        (does occasional network I/O) — call via run_in_threadpool."""
        try:
            signing_key = self._jwks.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                audience=self.audience,
                issuer=self.issuer,
                options={"require": ["exp", "iss", "aud"]},
            )
        except jwt.PyJWTError as exc:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                detail=f"Invalid token: {exc}",
                headers={"WWW-Authenticate": "Bearer"},
            ) from exc
        return principal_from_claims(claims)


def principal_from_claims(claims: dict) -> Principal:
    roles = (claims.get("realm_access") or {}).get("roles", [])
    return Principal(
        sub=claims["sub"],
        username=claims.get("preferred_username", ""),
        email=claims.get("email"),
        name=claims.get("name"),
        roles=list(roles),
    )
