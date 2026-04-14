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
    API_BASE_URL: str = "http://localhost:8000"
    LIVEKIT_API_KEY: str = ""
    LIVEKIT_API_SECRET: str = ""
    LIVEKIT_WS_URL: str = "wss://localhost.livekit.cloud"
    ENVIRONMENT: str = "development"
    CORS_ORIGINS: list[str] = []
    LOG_LEVEL: str = "INFO"
    AWS_S3_BUCKET_NAME: str = ""
    AWS_DEFAULT_REGION: str = "us-east-1"
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_ENDPOINT_URL: str = "https://your-s3-endpoint.example.com"
    DEEPGRAM_API_KEY: str = ""
    RECORDING_ENABLED: bool = False
    SENTRY_DSN: str = ""
    DEMO_LOGIN_ENABLED: bool = False
    DEMO_CAST_HASH: str = ""
    CLOUDINARY_CLOUD_NAME: str = ""
    CLOUDINARY_API_KEY: str = ""
    CLOUDINARY_API_SECRET: str = ""
    NEYNAR_WEBHOOK_SECRET_CAST: str = ""
    NEYNAR_WEBHOOK_SECRET_REACTION: str = ""
    NEYNAR_WEBHOOK_SECRET_FOLLOW: str = ""
    NEYNAR_WEBHOOK_ID_CAST: str = ""
    NEYNAR_WEBHOOK_ID_REACTION: str = ""
    NEYNAR_WEBHOOK_ID_FOLLOW: str = ""
    FARCASTER_APP_MNEMONIC: str = ""
    FARCASTER_APP_FID: int = 0
    MINIAPP_WEBHOOK_SECRET: str = ""

    # Spam filtering
    SPAM_FILTER_ENABLED: bool = True

    # x402 agent payment settings
    X402_ENABLED: bool = False
    X402_PAYMENT_ADDRESS: str = ""  # payTo address for receiving USDC
    X402_FACILITATOR_URL: str = "https://api.cdp.coinbase.com/platform/v2/x402"
    X402_NETWORK: str = "eip155:8453"  # Base mainnet (CAIP-2)
    X402_USDC_ASSET: str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"  # USDC on Base
    AGENT_JOIN_TOLL: str = "1000"  # Amount in atomic units (1000 = 0.001 USDC)
    AGENT_FID_START: int = 9_000_000_000


settings = Settings()
