export interface NeynarUserViewerContext {
  following: boolean;
  followed_by: boolean;
}

export interface NeynarUser {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
  custody_address: string;
  follower_count: number;
  following_count: number;
  profile?: {
    bio?: {
      text?: string;
    };
  };
  viewer_context?: NeynarUserViewerContext;
  pro?: NeynarProStatus;
}

export interface NeynarProStatus {
  status: 'subscribed' | 'unsubscribed';
}

export interface NeynarCastAuthor {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
  pro?: NeynarProStatus;
}

export interface NeynarReactions {
  likes_count: number;
  recasts_count: number;
  likes: Array<{ fid: number }>;
  recasts: Array<{ fid: number }>;
}

export interface NeynarReplies {
  count: number;
}

export interface NeynarViewerContext {
  liked: boolean;
  recasted: boolean;
}

export interface NeynarEmbed {
  url?: string;
  cast?: NeynarCast;
  metadata?: {
    content_type?: string;
    _status?: string;
    image?: {
      width_px?: number;
      height_px?: number;
    };
  };
}

export interface NeynarCast {
  hash: string;
  author: NeynarCastAuthor;
  text: string;
  timestamp: string;
  reactions: NeynarReactions;
  replies: NeynarReplies;
  viewer_context?: NeynarViewerContext;
  embeds?: NeynarEmbed[];
  thread_hash: string | null;
  parent_hash: string | null;
}

export interface NeynarFeedResponse {
  casts: NeynarCast[];
  next: {
    cursor: string | null;
  };
}
