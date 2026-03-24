from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Look for .env in backend/ dir, then repo root
_backend_dir = Path(__file__).resolve().parent.parent
_env_candidates = [_backend_dir / ".env", _backend_dir.parent / ".env"]
_env_file = next((p for p in _env_candidates if p.exists()), ".env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(_env_file), extra="ignore")

    DATABASE_URL: str = "postgresql+asyncpg://dev:dev@localhost:5432/farcaster_audio"
    REDIS_URL: str = "redis://localhost:6379"
    JWT_SECRET: str = "change-me-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRY_HOURS: int = 72
    JWT_REFRESH_EXPIRY_DAYS: int = 30
    NEYNAR_API_KEY: str = ""
    NEYNAR_CLIENT_ID: str = ""
    LIVEKIT_API_KEY: str = ""
    LIVEKIT_API_SECRET: str = ""
    LIVEKIT_WS_URL: str = "wss://localhost.livekit.cloud"
    ENVIRONMENT: str = "development"
    CORS_ORIGINS: list[str] = []
    LOG_LEVEL: str = "INFO"
    S3_BUCKET: str = ""
    S3_REGION: str = "us-east-1"
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: str = ""
    RECORDING_ENABLED: bool = False
    SENTRY_DSN: str = ""


settings = Settings()
