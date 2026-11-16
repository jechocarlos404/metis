from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://metis:metis@localhost:5432/metis"
    cors_origins: str = "http://localhost:4321"

    # --- Auth (Keycloak / OIDC) ---
    # auth_enabled=false is a dev/test escape hatch: every request is treated as an
    # admin and no token is required. Keep it true anywhere real.
    auth_enabled: bool = True
    # Public issuer — must equal the token's `iss` (Keycloak's KC_HOSTNAME pins this
    # to the browser-facing URL even for back-channel calls).
    keycloak_issuer: str = "http://localhost:8080/realms/metis"
    # Back-channel base the backend uses to reach Keycloak (JWKS + Admin API).
    keycloak_internal_url: str = "http://localhost:8080"
    keycloak_realm: str = "metis"
    keycloak_audience: str = "metis-backend"
    keycloak_admin_client_id: str = "metis-backend"
    keycloak_admin_client_secret: str = "dev-backend-secret"
    # Which client a token was issued to decides its surface, and the surface
    # decides whether it may write. A service or MCP token cannot claim to be
    # the desktop, because `azp` is signed.
    keycloak_desktop_client: str = "metis-web"
    keycloak_mcp_client: str = "metis-mcp"
    keycloak_mcp_client_secret: str = "dev-mcp-secret"

    # The MCP server calls the HTTP API rather than the services in-process, so
    # a chat transcript and an API log line up — and so the write boundary is
    # inherited rather than re-implemented.
    mcp_api_base_url: str = "http://localhost:8000"
    # Required to serve MCP over SSE. Empty means stdio only — a listening
    # socket with no gate would lend this process's API token to any caller.
    mcp_sse_token: str = ""

    # LLM providers — presence of a credential marks the provider available.
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    openrouter_api_key: str = ""
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_region: str = ""
    ollama_base_url: str = "http://localhost:11434"

    # Model dropdown catalogs (comma-separated, env-overridable). Ollama's list
    # is discovered live from the running server instead.
    anthropic_models: str = "claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5"
    openai_models: str = "gpt-5.1,gpt-5.1-mini,gpt-4.1"
    openrouter_models: str = (
        "anthropic/claude-opus-4.8,openai/gpt-5.1,google/gemini-2.5-pro,meta-llama/llama-4-maverick"
    )
    bedrock_models: str = (
        "anthropic.claude-opus-4-8,anthropic.claude-sonnet-5,anthropic.claude-haiku-4-5"
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
