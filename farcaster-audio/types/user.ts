export interface UserProfile {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
  custody_address: string;
}

export interface AuthState {
  user: UserProfile | null;
  jwt: string | null;
  refresh_token: string | null;
  is_authenticated: boolean;
  is_loading: boolean;
}
