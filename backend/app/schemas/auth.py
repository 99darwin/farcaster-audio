from pydantic import BaseModel


class UserResponse(BaseModel):
    fid: int
    username: str
    display_name: str
    pfp_url: str | None = None
    custody_address: str | None = None
    is_pro: bool = False
    is_admin: bool = False


class LoginRequest(BaseModel):
    signer_uuid: str
    fid: int


class LoginResponse(BaseModel):
    jwt: str
    refresh_token: str
    expires_at: str
    user: UserResponse


class RefreshRequest(BaseModel):
    refresh_token: str


class AuthUrlResponse(BaseModel):
    authorization_url: str


class RegisterAuthAddressRequest(BaseModel):
    auth_address: str


class RegisterAuthAddressResponse(BaseModel):
    auth_address: str
    status: str
    approval_url: str | None = None


class AuthAddressStatusResponse(BaseModel):
    auth_address: str
    status: str
    fid: int | None = None
