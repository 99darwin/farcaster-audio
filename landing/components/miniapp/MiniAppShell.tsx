"use client";

import dynamic from "next/dynamic";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

const PersistentMiniAppBrowser = dynamic(
  () =>
    import("./MiniAppBrowser").then((module) => module.MiniAppBrowser),
  { ssr: false },
);

export interface MiniAppLaunchRequest {
  launchUrl: string;
  title?: string;
}

interface ActiveMiniApp extends MiniAppLaunchRequest {
  instanceId: number;
}

interface MiniAppShellValue {
  openMiniApp: (request: MiniAppLaunchRequest) => void;
  closeMiniApp: () => void;
}

const MiniAppShellContext = createContext<MiniAppShellValue | null>(null);

/**
 * Returns the persistent app-shell launcher when one is available. Components
 * that can also render outside `/app` may fall back to a local browser.
 */
export function useMiniAppShell(): MiniAppShellValue | null {
  return useContext(MiniAppShellContext);
}

/**
 * Owns the active mini app above sibling `/app` routes so Browse mode can keep
 * the iframe alive while the user navigates around Juke.
 */
export function MiniAppShellProvider({ children }: { children: ReactNode }) {
  const [activeMiniApp, setActiveMiniApp] = useState<ActiveMiniApp | null>(null);
  const nextInstanceId = useRef(0);

  const openMiniApp = useCallback((request: MiniAppLaunchRequest) => {
    nextInstanceId.current += 1;
    setActiveMiniApp({ ...request, instanceId: nextInstanceId.current });
  }, []);

  const closeMiniApp = useCallback(() => setActiveMiniApp(null), []);
  const value = useMemo(
    () => ({ openMiniApp, closeMiniApp }),
    [closeMiniApp, openMiniApp],
  );

  return (
    <MiniAppShellContext.Provider value={value}>
      {children}
      {activeMiniApp ? (
        <PersistentMiniAppBrowser
          key={activeMiniApp.instanceId}
          launchUrl={activeMiniApp.launchUrl}
          title={activeMiniApp.title}
          onClose={closeMiniApp}
        />
      ) : null}
    </MiniAppShellContext.Provider>
  );
}
