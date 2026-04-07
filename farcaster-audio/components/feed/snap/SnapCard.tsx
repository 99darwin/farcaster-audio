import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { View, StyleSheet, Linking, Pressable, Text, ActivityIndicator } from 'react-native';
import type { ReactNode } from 'react';
import type { SnapAccent, SnapElement, SnapInputValue, SnapInputs, SnapResponse } from '@/types/snap';
import { SnapContext, type SnapContextValue } from './context';
import { SnapRenderer } from './SnapRenderer';
import { Confetti } from './effects/Confetti';
import { DEFAULT_SNAP_ACCENT, resolvePaletteColor } from '@/constants/snapPalette';
import { colors } from '@/constants/theme';
import { useAuthStore } from '@/stores/authStore';
import {
  getSnapSignerStatus as fetchSignerStatus,
  registerSnapSigner,
  signSnapSubmit,
  type SnapSignerStatus,
} from '@/services/snapSigner';
import { submitSnap } from '@/services/snapClient';

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

/** Walk the element tree depth-first from root and assign 0-based button indices. */
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

  const [signerStatus, setSignerStatus] = useState<SnapSignerStatus>('none');
  const [registering, setRegistering] = useState(false);
  const signerCheckedRef = useRef(false);

  const { response, submitting } = state;
  const accent: SnapAccent = response.theme?.accent ?? DEFAULT_SNAP_ACCENT;
  const accentColor = resolvePaletteColor('accent', accent);
  const hasConfetti = response.effects?.includes('confetti') ?? false;

  // Lazy signer status check — only when fid is available
  useEffect(() => {
    if (!fid || signerCheckedRef.current) return;
    signerCheckedRef.current = true;
    fetchSignerStatus(fid)
      .then(setSignerStatus)
      .catch(() => {});
  }, [fid]);

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

  const handleEnableInteractions = useCallback(async () => {
    if (!fid || registering) return;
    setRegistering(true);
    try {
      const result = await registerSnapSigner(fid);
      if (result.approvalUrl) {
        await Linking.openURL(result.approvalUrl).catch(() => {});
      }
      setSignerStatus(result.status === 'approved' ? 'approved' : 'pending_approval');
    } catch {
      // swallow — user can retry
    } finally {
      setRegistering(false);
    }
  }, [fid, registering]);

  const submitButton = useCallback(
    async (elementId: string) => {
      if (!fid) return;
      const buttonIndex = buttonIndexMap[elementId];
      if (buttonIndex === undefined) return;

      if (signerStatus !== 'approved') {
        const latest = await fetchSignerStatus(fid);
        setSignerStatus(latest);
        if (latest !== 'approved') {
          await handleEnableInteractions();
          return;
        }
      }

      // Resolve per-button POST target — snaps can route to different URLs
      // via on.press.params.target. Fall back to the original snap URL.
      const element = state.response.ui.elements[elementId] as
        | { on?: { press?: { params?: { target?: string } } } }
        | undefined;
      const target = element?.on?.press?.params?.target ?? url;

      dispatch({ type: 'submit-start' });
      try {
        const jfs = await signSnapSubmit(
          fid,
          buttonIndex,
          state.inputs as Record<string, string | number | boolean>,
        );
        const next = await submitSnap(target, jfs);
        dispatch({ type: 'submit-success', response: next });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Submit failed';
        dispatch({ type: 'submit-error', error: message });
      }
    },
    [fid, buttonIndexMap, signerStatus, handleEnableInteractions, state.inputs, state.response.ui.elements, url],
  );

  const buttonIndexFor = useCallback(
    (elementId: string) => buttonIndexMap[elementId] ?? -1,
    [buttonIndexMap],
  );

  const contextValue: SnapContextValue = useMemo(
    () => ({
      accent,
      elements: response.ui.elements,
      inputs: state.inputs,
      setInput,
      renderChildren,
      buttonIndexFor,
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
      buttonIndexFor,
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
