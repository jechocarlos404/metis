"""User management schemas. Users live in Keycloak (not the DB), so these are
plain representations shaped from the Keycloak Admin API — no Stamped base."""

from typing import Literal

from pydantic import BaseModel, Field

Role = Literal["admin", "editor", "viewer"]


class UserRead(BaseModel):
    id: str
    username: str
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    enabled: bool = True
    # The user's single managed realm role (admin/editor/viewer), if assigned.
    role: Role | None = None


class UserCreate(BaseModel):
    username: str = Field(min_length=1)
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    role: Role = "viewer"
    password: str = Field(min_length=1)
    # Force a password change on first login (Keycloak UPDATE_PASSWORD action).
    temporary: bool = True


class UserUpdate(BaseModel):
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    enabled: bool | None = None
    role: Role | None = None


class PasswordReset(BaseModel):
    password: str = Field(min_length=1)
    temporary: bool = True
