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
  status: "subscribed" | "unsubscribed";
}

export interface NeynarCastAuthor {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
  pro?: NeynarProStatus;
  is_spam?: boolean;
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

export interface NeynarOgMeta {
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: Array<{ url: string; width?: string; height?: string }>;
  ogUrl?: string;
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
    html?: NeynarOgMeta & {
      favicon?: string;
      oembed?: {
        type?: string;
        html?: string;
        author_name?: string;
        author_url?: string;
        provider_name?: string;
      };
    };
    /** Neynar mini-app / frame metadata */
    fc_frame?: {
      image_url?: string;
      button?: { title?: string; action?: { type?: string; url?: string } };
      [key: string]: unknown;
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

export type NeynarCastWithReplies = NeynarCast & {
  direct_replies?: NeynarCastWithReplies[];
};

export interface NeynarFeedResponse {
  casts: NeynarCast[];
  next: {
    cursor: string | null;
  };
}

// --- Notifications ---

export type NotificationType =
  | "likes"
  | "recasts"
  | "follows"
  | "reply"
  | "mention"
  | "quote";

export interface NeynarNotificationReaction {
  object: string;
  cast: NeynarCast;
  user: NeynarCastAuthor;
}

export interface NeynarNotificationFollow {
  object: string;
  user: NeynarCastAuthor;
}

export interface NeynarNotification {
  type: NotificationType;
  most_recent_timestamp: string;
  seen: boolean;
  cast?: NeynarCast;
  reactions?: NeynarNotificationReaction[];
  follows?: NeynarNotificationFollow[];
  count?: number;
}

export interface NotificationsResponse {
  notifications: NeynarNotification[];
  next: { cursor: string | null };
}
