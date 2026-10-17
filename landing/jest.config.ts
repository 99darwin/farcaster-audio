import type { Config } from "jest";

/**
 * Jest config scoped to landing/lib unit tests.
 *
 * Next.js pages are not under test here — Next has its own runtime that
 * jest can't easily simulate. This config exists to give us a fast,
 * isolated runner for pure-function libs in landing/lib.
 */
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/lib/**/__tests__/**/*.test.ts"],
  moduleFileExtensions: ["ts", "tsx", "js"],
  // Resolve the `@/` path alias (mirrors tsconfig `paths`) so lib modules that
  // import via `@/lib/...` are resolvable when pulled into a test.
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  // Don't compile the rest of the app — just the lib + test files.
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          target: "ES2020",
          module: "commonjs",
          esModuleInterop: true,
          strict: true,
          isolatedModules: true,
          skipLibCheck: true,
        },
      },
    ],
  },
};

export default config;
