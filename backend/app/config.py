from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://metis:metis@localhost:5432/metis"
    seed_demo_data: bool = True
    cors_origins: str = "*"

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
