from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Mongo ---
    mongo_uri: str = "mongodb://localhost:27017"
    mongo_db: str = "lixionary_stock_v2"

    # --- App ---
    app_timezone: str = "Asia/Jakarta"
    api_host: str = "0.0.0.0"
    api_port: int = 8850
    log_level: str = "INFO"
    cors_origins: str = "http://localhost:3000"

    # --- Ingestion ---
    # Concurrent Yahoo requests. Kept low deliberately: Yahoo rate-limits hard,
    # and 30-odd symbols fit comfortably inside a 5 minute window at this width.
    fetch_concurrency: int = 4
    fetch_jitter_ms: int = 250
    fetch_timeout_s: float = 30.0
    fetch_max_attempts: int = 4

    # Circuit breaker: after this many consecutive rate-limit errors, stop
    # calling Yahoo entirely for the cooldown period.
    breaker_threshold: int = 5
    breaker_cooldown_s: int = 900

    # --- Backfill windows (see plan; these are Yahoo's hard limits) ---
    backfill_5m_days: int = 60
    backfill_1h_days: int = 730
    backfill_1d_period: str = "max"

    # --- Retention ---
    ingest_runs_ttl_days: int = 30

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
