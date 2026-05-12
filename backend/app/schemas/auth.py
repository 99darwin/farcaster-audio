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
    # When true, the server returns the refresh token via an HttpOnly cookie
    # (`juke_refresh`) and omits it from the response body. Used by the
    # developer dashboard at juke.audio to mitigate XSS exfiltration of the
    # 30-day refresh window. Existing miniapp/embed callers default to false
    # and continue to receive the body-based refresh token unchanged.
    use_cookie: bool = False


class LoginResponse(BaseModel):
    jwt: str
    refresh_token: str | None = None
    expires_at: str
    user: UserResponse


class RefreshRequest(BaseModel):
    # Optional: the refresh token may instead arrive via the `juke_refresh`
    # HttpOnly cookie. If both are present, the cookie wins.
    refresh_token: str | None = None


class AuthUrlResponse(BaseModel):
    authorization_url: str


class SignerCreateResponse(BaseModel):
    """Returned to the web SIWN client. The client opens
    `signer_approval_url` in a popup and polls
    `/v1/auth/signer/status` with `signer_uuid` until approved.
    """

    signer_uuid: str
    signer_approval_url: str


class SignerStatusResponse(BaseModel):
    """Polled status of a Neynar managed signer.

    `status` is one of: `generated`, `pending_approval`, `approved`,
    `revoked`. `fid` is populated once the user approves on-device.
    """

    status: str
    fid: int | None = None


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


class InvalidateAuthAddressRequest(BaseModel):
    auth_address: str
