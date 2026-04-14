import { createContext, useContext, useRef, useCallback } from "react";
import { type View } from "react-native";

interface Position {
  x: number;
  y: number;
}

interface AvatarPositionContextValue {
  register: (fid: number, ref: View) => void;
  measure: (fid: number) => Promise<Position | null>;
}

const AvatarPositionContext = createContext<AvatarPositionContextValue | null>(
  null,
);

export function AvatarPositionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const refs = useRef<Map<number, View>>(new Map());

  const register = useCallback((fid: number, ref: View) => {
    refs.current.set(fid, ref);
  }, []);

  const measure = useCallback((fid: number): Promise<Position | null> => {
    const ref = refs.current.get(fid);
    if (!ref) return Promise.resolve(null);

    return new Promise((resolve) => {
      ref.measureInWindow((x, y, width, height) => {
        if (width === 0 && height === 0) {
          resolve(null);
        } else {
          resolve({ x: x + width / 2, y: y + height / 2 });
        }
      });
    });
  }, []);

  return (
    <AvatarPositionContext.Provider value={{ register, measure }}>
      {children}
    </AvatarPositionContext.Provider>
  );
}

export function useAvatarPosition() {
  const ctx = useContext(AvatarPositionContext);
  if (!ctx)
    throw new Error(
      "useAvatarPosition must be used within AvatarPositionProvider",
    );
  return ctx;
}
