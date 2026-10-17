/** Paging rules for the "who reacted" popover. */

export interface ReactorPagingState {
  /** Entries matching the selected tab. */
  visibleCount: number;
  /** Cursor for the next page; null before the first page or when done. */
  cursor: string | null;
  hasMore: boolean;
  isLoading: boolean;
  hasError: boolean;
}

/**
 * Fetch the next page without a click while the selected tab is still empty:
 * pages are mixed across emojis, so a tab's first reactor can sit pages deep.
 */
export function shouldAutoPageReactors(state: ReactorPagingState): boolean {
  return (
    state.visibleCount === 0 &&
    state.hasMore &&
    state.cursor !== null &&
    !state.isLoading &&
    !state.hasError
  );
}
