/**
 * State of the user's Juke app signer in KeyRegistry. Anything other than
 * `approved` means the app runs read-only and shows the re-link prompt.
 */
export type SignerStatus = "none" | "pending" | "approved" | "revoked";

export interface UserProfile {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
  custody_address: string;
  is_pro: boolean;
  is_admin: boolean;
  /** Absent on profiles persisted before the Hypersnap cutover. */
  signer_status?: SignerStatus;
}

export interface AuthState {
  user: UserProfile | null;
  jwt: string | null;
  refresh_token: string | null;
  is_authenticated: boolean;
  is_loading: boolean;
}
