from pydantic import BaseModel, Field


class RegisterSnapSignerRequest(BaseModel):
    public_key: str = Field(
        ...,
        pattern=r"^0x[0-9a-fA-F]{64}$",
        description="Ed25519 public key, 0x + 64 hex chars",
    )


class RegisterSnapSignerResponse(BaseModel):
    public_key: str
    status: str
    approval_url: str | None = None


class SnapSignerStatusResponse(BaseModel):
    public_key: str
    status: str
    fid: int | None = None


class InvalidateSnapSignerRequest(BaseModel):
    public_key: str = Field(
        ...,
        pattern=r"^0x[0-9a-fA-F]{64}$",
        description="Ed25519 public key to mark as revoked",
    )
