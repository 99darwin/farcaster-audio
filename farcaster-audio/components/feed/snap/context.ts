import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { SnapAccent, SnapElement, SnapInputs, SnapInputValue } from '@/types/snap';
import type { SnapSignerStatus } from '@/services/snapSigner';

export interface SnapContextValue {
  accent: SnapAccent;
  elements: Record<string, SnapElement>;
  inputs: SnapInputs;
  setInput: (name: string, value: SnapInputValue) => void;
  renderChildren: (ids: string[] | undefined, depth: number) => ReactNode;
  /** Button index (1-based) assigned to an element id during tree walk. */
  buttonIndexFor: (elementId: string) => number;
  /** Submit a button press. Resolves once the response is applied. */
  submitButton: (elementId: string) => Promise<void>;
  /** Current signer status. Determines whether buttons enable interaction. */
  signerStatus: SnapSignerStatus;
  /** True while a submit is in flight. */
  submitting: boolean;
}

export const SnapContext = createContext<SnapContextValue | null>(null);

export function useSnapContext(): SnapContextValue {
  const ctx = useContext(SnapContext);
  if (!ctx) throw new Error('useSnapContext must be used inside <SnapCard>');
  return ctx;
}

export const MAX_RENDER_DEPTH = 10;

export const GAP_VALUES: Record<'none' | 'sm' | 'md' | 'lg', number> = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 16,
};
