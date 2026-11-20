"""Admin-only user management, proxied to the Keycloak Admin API.

The whole router is gated behind `require_admin` at include time (see app.main);
there is no local user table — Keycloak is the store.
"""

from collections.abc import Awaitable
from typing import TypeVar

import httpx
from fastapi import APIRouter, HTTPException, Request

from app.config import get_settings
from app.schemas.user import PasswordReset, UserCreate, UserRead, UserUpdate
from app.services.keycloak_admin import KeycloakAdmin, KeycloakAdminError

router = APIRouter(prefix="/api/users", tags=["users"])

T = TypeVar("T")


def _admin(request: Request) -> KeycloakAdmin:
    admin = getattr(request.app.state, "kc_admin", None)
    if admin is None:
        admin = KeycloakAdmin(get_settings())
        request.app.state.kc_admin = admin
    return admin


def _detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
        return body.get("errorMessage") or body.get("error") or resp.text
    except ValueError:
        return resp.text or resp.reason_phrase


async def _call(coro: Awaitable[T], what: str) -> T:
    """Run a Keycloak Admin call, mapping its errors to HTTP responses whose
    detail an admin can read. `what` finishes "Keycloak didn't let metis …"."""
    try:
        return await coro
    except KeycloakAdminError as exc:
        raise HTTPException(502, str(exc)) from exc
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        detail = _detail(exc.response)
        if code in (400, 404, 409):
            raise HTTPException(code, detail) from exc
        if code in (401, 403):
            raise HTTPException(
                502,
                f"Keycloak didn't let metis {what}: its metis-backend service account "
                "is missing a permission.",
            ) from exc
        raise HTTPException(502, f"Keycloak failed to {what} (status {code}).") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"metis couldn't reach Keycloak to {what}.") from exc


@router.get("", response_model=list[UserRead])
async def list_users(request: Request):
    return await _call(_admin(request).list_users(), "list users")


@router.post("", response_model=UserRead, status_code=201)
async def create_user(data: UserCreate, request: Request):
    return await _call(_admin(request).create_user(data), "create the user")


@router.get("/{user_id}", response_model=UserRead)
async def get_user(user_id: str, request: Request):
    return await _call(_admin(request).get_user(user_id), "read the user")


@router.patch("/{user_id}", response_model=UserRead)
async def update_user(user_id: str, data: UserUpdate, request: Request):
    return await _call(_admin(request).update_user(user_id, data), "change the user")


@router.delete("/{user_id}", status_code=204)
async def delete_user(user_id: str, request: Request):
    await _call(_admin(request).delete_user(user_id), "delete the user")


@router.post("/{user_id}/reset-password", status_code=204)
async def reset_password(user_id: str, data: PasswordReset, request: Request):
    await _call(_admin(request).reset_password(user_id, data), "set the password")
