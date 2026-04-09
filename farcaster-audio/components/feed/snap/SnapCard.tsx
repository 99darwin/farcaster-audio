import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { View, StyleSheet, Linking, Pressable, Text, ActivityIndicator, AppState, type AppStateStatus } from 'react-native';
import type { ReactNode } from 'react';
import type { SnapAccent, SnapElement, SnapInputValue, SnapInputs, SnapResponse } from '@/types/snap';
import { SnapContext, type SnapContextValue } from './context';
import { SnapRenderer } from './SnapRenderer';
import { Confetti } from './effects/Confetti';
import { DEFAULT_SNAP_ACCENT, resolvePaletteColor } from '@/constants/snapPalette';
import { colors } from '@/constants/theme';
import { useAuthStore } from '@/stores/authStore';
import { registerSnapSigner, signSnapSubmit, signSnapSubmitV1 } from '@/services/snapSigner';
import { useSnapSignerStatus } from '@/hooks/useSnapSignerStatus';
import {
  submitSnap,
  assertSafeSnapUrl,
  isSameOriginSnapTarget,
  SnapSubmitError,
} from '@/services/snapClient';

/**
 * Walk the element tree depth-first from root and assign 0-based button
 * indices. Used only for the v1 fallback path — v2 discriminates buttons
 * by their distinct submit `target` URL instead.
 */
function buildButtonIndexMap(
  rootId: string,
  elements: Record<string, SnapElement>,
): Record<string, number> {
  const map: Record<string, number> = {};
  const visited = new Set<string>();
  let counter = 0;

  const walk = (id: string, depth: number) => {
    if (depth > 20 || visited.has(id)) return;
    visited.add(id);
    const el = elements[id];
    if (!el) return;
    if (el.type === 'button') {
      map[id] = counter;
      counter += 1;
    }
    if (el.children) {
      for (const childId of el.children) walk(childId, depth + 1);
    }
  };

  walk(rootId, 0);
  return map;
}

/** Hard cap for the post-approval AppState listener. */
const APPROVAL_WATCH_MAX_MS = 10 * 60 * 1000;

/**
 * Heuristic for "the snap server told us this signer is revoked".
 * Different snap implementations surface this differently, so we're
 * defensive: any 401/403 or any message mentioning both "signer" and
 * "revoked" (or "invalid signer") counts.
 */
function looksLikeSignerRevoked(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { status?: number; response?: { status?: number }; message?: string };
  const status = anyErr.status ?? anyErr.response?.status;
  if (status === 401 || status === 403) return true;
  const msg = (anyErr.message ?? '').toLowerCase();
  if (!msg) return false;
  if (msg.includes('signer') && msg.includes('revoked')) return true;
  if (msg.includes('invalid signer')) return true;
  if (msg.includes('signer not found')) return true;
  return false;
}

interface State {
  inputs: SnapInputs;
  response: SnapResponse;
  submitting: boolean;
  error: string | null;
  confettiKey: number;
}

type Action =
  | { type: 'set-input'; name: string; value: SnapInputValue }
  | { type: 'submit-start' }
  | { type: 'submit-success'; response: SnapResponse }
  | { type: 'submit-error'; error: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'set-input':
      return { ...state, inputs: { ...state.inputs, [action.name]: action.value } };
    case 'submit-start':
      return { ...state, submitting: true, error: null };
    case 'submit-success':
      return {
        ...state,
        submitting: false,
        response: action.response,
        inputs: {},
        confettiKey: state.confettiKey + 1,
      };
    case 'submit-error':
      return { ...state, submitting: false, error: action.error };
    default:
      return state;
  }
}

interface SnapCardProps {
  url: string;
  response: SnapResponse;
}

export function SnapCard({ url, response: initialResponse }: SnapCardProps) {
  const fid = useAuthStore((s) => s.user?.fid ?? 0);
  const [state, dispatch] = useReducer(reducer, {
    inputs: {},
    response: initialResponse,
    submitting: false,
    error: null,
    confettiKey: 0,
  });

  const { status: signerStatus, refresh: refreshSignerStatus, invalidate: invalidateSigner } = useSnapSignerStatus(fid);
  const [registering, setRegistering] = useState(false);
  const appStateCleanupRef = useRef<(() => void) | null>(null);

  const { response, submitting } = state;
  const accent: SnapAccent = response.theme?.accent ?? DEFAULT_SNAP_ACCENT;
  const accentColor = resolvePaletteColor('accent', accent);
  const hasConfetti = response.effects?.includes('confetti') ?? false;

  // Ensure we tear down any lingering AppState listener on unmount.
  useEffect(() => {
    return () => {
      if (appStateCleanupRef.current) {
        appStateCleanupRef.current();
        appStateCleanupRef.current = null;
      }
    };
  }, []);

  // Only consulted for the v1 fallback payload — v2 identifies buttons by
  // their distinct submit `target` URL.
  const buttonIndexMap = useMemo(
    () => buildButtonIndexMap(response.ui.root, response.ui.elements),
    [response.ui.root, response.ui.elements],
  );

  const setInput = useCallback((name: string, value: SnapInputValue) => {
    dispatch({ type: 'set-input', name, value });
  }, []);

  const renderChildren = useCallback(
    (ids: string[] | undefined, depth: number): ReactNode => {
      if (!ids || ids.length === 0) return null;
      return ids.map((id) => <SnapRenderer key={id} rootId={id} depth={depth} />);
    },
    [],
  );

  const startApprovalWatch = useCallback(() => {
    if (appStateCleanupRef.current) {
      appStateCleanupRef.current();
      appStateCleanupRef.current = null;
    }

    let cancelled = false;

    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (cancelled) return;
      if (next !== 'active') return;
      void refreshSignerStatus({ force: true }).then((result) => {
        if (cancelled) return;
        if (result === 'approved') {
          cleanup();
        }
      });
    });

    const timeout = setTimeout(() => {
      cleanup();
    }, APPROVAL_WATCH_MAX_MS);

    const cleanup = () => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timeout);
      subscription.remove();
      if (appStateCleanupRef.current === cleanup) {
        appStateCleanupRef.current = null;
      }
    };

    appStateCleanupRef.current = cleanup;
  }, [refreshSignerStatus]);

  const handleEnableInteractions = useCallback(async () => {
    if (!fid || registering) return;
    setRegistering(true);
    try {
      const result = await registerSnapSigner(fid);
      if (result.approvalUrl) {
        await Linking.openURL(result.approvalUrl).catch(() => {});
      }
      if (result.status === 'approved') {
        await refreshSignerStatus();
      } else {
        // Pending: watch for return from Farcaster and re-check once.
        startApprovalWatch();
        await refreshSignerStatus();
      }
    } catch {
      // swallow — user can retry
    } finally {
      setRegistering(false);
    }
  }, [fid, registering, refreshSignerStatus, startApprovalWatch]);

  const handleManualApprovalCheck = useCallback(() => {
    void refreshSignerStatus({ force: true });
  }, [refreshSignerStatus]);

  const submitButton = useCallback(
    async (elementId: string) => {
      if (!fid) return;
      const element = state.response.ui.elements[elementId];
      if (!element || element.type !== 'button') return;

      if (signerStatus !== 'approved') {
        const latest = await refreshSignerStatus();
        if (latest !== 'approved') {
          await handleEnableInteractions();
          return;
        }
      }

      // Resolve per-button POST target — snap v2 uses a distinct submit
      // `target` URL as the button discriminator. To defeat signed-body
      // exfiltration we require the target to share the snap origin and
      // pass a safe-URL check (https + not a private/loopback host).
      const pressParams = (element.on?.press as { params?: { target?: string } } | undefined)
        ?.params;
      const rawTarget = pressParams?.target ?? url;
      let target: string;
      try {
        target = assertSafeSnapUrl(rawTarget);
      } catch {
        dispatch({ type: 'submit-error', error: 'Unsafe snap target URL' });
        return;
      }
      if (!isSameOriginSnapTarget(target, url)) {
        dispatch({
          type: 'submit-error',
          error: 'Snap target must share the origin of the original snap URL',
        });
        return;
      }

      // v2 `audience` is `scheme://host` (no port) per the upgrading doc.
      // After the same-origin check, this equals the snap server's origin
      // that the JFS claim will be verified against.
      const targetUrl = new URL(target);
      const audience = `${targetUrl.protocol}//${targetUrl.hostname}`;

      const inputs = state.inputs as Record<string, string | number | boolean>;

      dispatch({ type: 'submit-start' });
      try {
        const jfs = await signSnapSubmit(fid, inputs, { audience });
        const next = await submitSnap(target, jfs);
        dispatch({ type: 'submit-success', response: next });
      } catch (err) {
        // v1 fallback: if a v2 submit is rejected with a 4xx the server is
        // still on the v1 spec. Re-sign with the v1 payload shape (restore
        // button_index, drop nonce/audience) and retry once. See:
        // docs.farcaster.xyz/snap/2.0/client-upgrade
        const isClientError =
          err instanceof SnapSubmitError &&
          typeof err.status === 'number' &&
          err.status >= 400 &&
          err.status < 500;

        if (isClientError) {
          const buttonIndex = buttonIndexMap[elementId];
          if (buttonIndex !== undefined) {
            try {
              const jfsV1 = await signSnapSubmitV1(fid, buttonIndex, inputs);
              const next = await submitSnap(target, jfsV1);
              dispatch({ type: 'submit-success', response: next });
              return;
            } catch (fallbackErr) {
              const message =
                fallbackErr instanceof Error ? fallbackErr.message : 'Submit failed';
              dispatch({ type: 'submit-error', error: message });
              return;
            }
          }
        }

        const message = err instanceof Error ? err.message : 'Submit failed';
        if (looksLikeSignerRevoked(err)) {
          await invalidateSigner();
          dispatch({ type: 'submit-error', error: 'Signer revoked — tap to enable interactions' });
          return;
        }
        dispatch({ type: 'submit-error', error: message });
      }
    },
    [fid, signerStatus, refreshSignerStatus, handleEnableInteractions, invalidateSigner, state.inputs, state.response.ui.elements, url, buttonIndexMap],
  );

  const contextValue: SnapContextValue = useMemo(
    () => ({
      accent,
      elements: response.ui.elements,
      inputs: state.inputs,
      setInput,
      renderChildren,
      submitButton,
      signerStatus,
      submitting,
    }),
    [
      accent,
      response.ui.elements,
      state.inputs,
      setInput,
      renderChildren,
      submitButton,
      signerStatus,
      submitting,
    ],
  );

  const handleOpenExternal = () => {
    Linking.openURL(url).catch(() => {});
  };

  return (
    <View style={[styles.card, { borderColor: accentColor + '55' }]}>
      <SnapContext.Provider value={contextValue}>
        <View style={styles.content}>
          <SnapRenderer rootId={response.ui.root} />
        </View>
      </SnapContext.Provider>

      {signerStatus === 'pending_approval' ? (
        <View style={[styles.banner, { backgroundColor: accentColor + '22' }]}>
          <Text style={[styles.bannerText, { color: accentColor }]}>
            Snap signer pending approval — open Farcaster to approve
          </Text>
          <Pressable onPress={handleManualApprovalCheck} style={styles.bannerAction}>
            <Text style={[styles.bannerActionText, { color: accentColor }]}>
              I approved it — check now
            </Text>
          </Pressable>
        </View>
      ) : null}

      {state.error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText} numberOfLines={2}>{state.error}</Text>
        </View>
      ) : null}

      <Pressable onPress={handleOpenExternal} style={styles.footer}>
        <Text style={[styles.footerLabel, { color: accentColor }]}>Snap</Text>
        {submitting ? <ActivityIndicator size="small" color={accentColor} /> : null}
        <Text style={styles.footerDomain} numberOfLines={1}>
          {safeDomain(url)}
        </Text>
      </Pressable>

      {hasConfetti ? <Confetti triggerKey={`${response.ui.root}:${state.confettiKey}`} /> : null}
    </View>
  );
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const styles = StyleSheet.create({
  card: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: colors.background.main,
  },
  content: {
    padding: 12,
    gap: 8,
  },
  banner: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  bannerText: {
    fontSize: 11,
    fontWeight: '600',
  },
  bannerAction: {
    marginTop: 4,
    alignSelf: 'flex-start',
  },
  bannerActionText: {
    fontSize: 11,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  errorBanner: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#ef444422',
  },
  errorText: {
    fontSize: 11,
    color: '#ef4444',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.background.border,
    gap: 8,
  },
  footerLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  footerDomain: {
    color: colors.text.secondary,
    fontSize: 11,
    flex: 1,
    textAlign: 'right',
  },
});
