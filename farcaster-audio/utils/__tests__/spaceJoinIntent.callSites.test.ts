/**
 * Guard for M3: any in-app navigation into a live space must mark join
 * intent, or the user gets a spurious "Join this space?" sheet (and a host
 * who declines it leaves their own fresh room unattended).
 */
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";

const APP_ROOT = join(__dirname, "..", "..");

/** Files that navigate to `/space/<id>` from an in-app tap. */
const CALL_SITES = [
  "app/space/create.tsx",
  "components/spaces/SpacesRail.tsx",
  "components/spaces/SpaceMiniBar.tsx",
  "components/feed/FarcasterSpaceEmbedCard.tsx",
];

const SPACE_NAVIGATION = /router\.(push|replace)\(\s*`\/space\/\$\{([^}]+)\}`/g;

describe("space join intent call sites", () => {
  it.each(CALL_SITES)("%s marks intent before every space navigation", (file) => {
    const source = readFileSync(join(APP_ROOT, file), "utf8");
    const navigations = [...source.matchAll(SPACE_NAVIGATION)];
    expect(navigations.length).toBeGreaterThan(0);
    for (const match of navigations) {
      const preceding = source.slice(Math.max(0, (match.index ?? 0) - 200), match.index);
      expect(preceding).toContain(`markSpaceJoinIntent(${match[2]})`);
    }
  });
});
