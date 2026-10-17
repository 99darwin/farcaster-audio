export interface FarcasterUserViewerContext {
  following: boolean;
  followed_by: boolean;
  blocked?: boolean;
}

export interface FarcasterUser {
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
  viewer_context?: FarcasterUserViewerContext;
  pro?: FarcasterProStatus;
}

export interface FarcasterProStatus {
  status: "subscribed" | "unsubscribed";
}

export interface FarcasterCastAuthor {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
  pro?: FarcasterProStatus;
  is_spam?: boolean;
}

export interface FarcasterReactions {
  likes_count: number;
  recasts_count: number;
  likes: Array<{ fid: number }>;
  recasts: Array<{ fid: number }>;
}

export interface FarcasterReplies {
  count: number;
}

export interface FarcasterViewerContext {
  liked: boolean;
  recasted: boolean;
  bookmarked?: boolean;
}

export interface FarcasterChannel {
  id: string;
  name?: string | null;
  image_url?: string | null;
  parent_url?: string | null;
}

export interface FarcasterOgMeta {
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: Array<{ url: string; width?: string; height?: string }>;
  ogUrl?: string;
}

export interface FarcasterEmbed {
  url?: string;
  cast?: FarcasterCast;
  metadata?: {
    content_type?: string;
    _status?: string;
    image?: {
      width_px?: number;
      height_px?: number;
    };
    html?: FarcasterOgMeta & {
      favicon?: string;
      oembed?: {
        type?: string;
        html?: string;
        author_name?: string;
        author_url?: string;
        provider_name?: string;
      };
    };
    /** Mini-app / frame metadata */
    fc_frame?: {
      image_url?: string;
      button?: { title?: string; action?: { type?: string; url?: string } };
      [key: string]: unknown;
    };
  };
}

/** Compact preview of the cast a reply responds to, attached by feed reads. */
export interface FarcasterParentCast {
  hash: string;
  author: {
    fid: number;
    username?: string | null;
    display_name?: string | null;
    pfp_url?: string | null;
  };
  text: string;
  timestamp?: string | null;
}

export interface FarcasterCast {
  hash: string;
  author: FarcasterCastAuthor;
  text: string;
  timestamp: string;
  reactions: FarcasterReactions;
  replies: FarcasterReplies;
  viewer_context?: FarcasterViewerContext;
  embeds?: FarcasterEmbed[];
  channel?: FarcasterChannel | null;
  thread_hash: string | null;
  parent_hash: string | null;
  parent_author?: {
    fid: number;
    username?: string;
    display_name?: string;
    pfp_url?: string | null;
  };
  /**
   * The cast this reply answers, attached by feed reads. Current backends send
   * the full cast (rendered above the reply, X-style); older ones a preview.
   */
  parent_cast?: FarcasterCast | FarcasterParentCast | null;
}

export type FarcasterCastWithReplies = FarcasterCast & {
  direct_replies?: FarcasterCastWithReplies[];
};

export interface FarcasterFeedResponse {
  casts: FarcasterCast[];
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

export interface FarcasterNotificationReaction {
  object: string;
  cast: FarcasterCast;
  user: FarcasterCastAuthor;
}

export interface FarcasterNotificationFollow {
  object: string;
  user: FarcasterCastAuthor;
}

export interface FarcasterNotification {
  type: NotificationType;
  most_recent_timestamp: string;
  seen: boolean;
  cast?: FarcasterCast;
  reactions?: FarcasterNotificationReaction[];
  follows?: FarcasterNotificationFollow[];
  count?: number;
}

export interface NotificationsResponse {
  notifications: FarcasterNotification[];
  next: { cursor: string | null };
}
