# Contributing

Thanks for your interest in contributing to Juke.

## Branch naming

Use one of the following prefixes:

- `feat/` — new feature
- `fix/` — bug fix
- `chore/` — tooling, deps, build, infra
- `docs/` — documentation only
- `refactor/` — code change that neither fixes a bug nor adds a feature
- `test/` — test-only changes

Never commit directly to `main`. Open a PR from your feature branch.

## Commit messages

[Conventional commits](https://www.conventionalcommits.org/) are required:

```
feat(rooms): add raise-hand reaction
fix(auth): handle expired refresh tokens
docs(readme): clarify LiveKit setup
chore(deps): bump expo to 55.0.13
```

Scopes are encouraged but not strictly enforced. Use lower-kebab-case for scopes.

## Per-app development

### `backend/` (Python 3.12, FastAPI)

```bash
cd backend
docker-compose up           # boots Postgres, Redis, and the API

# In a separate shell
pytest                      # full test suite (uses testcontainers)
black .                     # format
ruff check .                # lint
```

Style: PEP 8, Black formatting at 88-char line length, Ruff for lint. Use `async`/`await` for all I/O.

### `farcaster-audio/` (Expo SDK 55, React Native, iOS-only)

```bash
cd farcaster-audio
npm install
cd ios && pod install && cd ..
npx expo start              # dev server; press `i` for iOS simulator

npx jest                    # tests
npm run lint                # eslint
npm run typecheck           # tsc --noEmit
```

Style: TypeScript strict mode, ESLint + Prettier. Prefer `const` over `let`; never `var`. Named exports over default exports.

### `landing/` (Next.js 15, App Router)

```bash
cd landing
npm install
npm run dev                 # dev server at http://localhost:3000

npm run build               # production build (acts as the smoke test)
npm run lint                # next lint
```

Style: TypeScript strict, ESLint + Prettier, Tailwind CSS 4.

## Forking notes

If you fork Juke and intend to ship your own iOS build:

1. **Create your own Expo project**: `cd farcaster-audio && eas init` to bind a fresh EAS project ID. Do not reuse the upstream project ID.
2. **Replace App Store Connect credentials**: edit `farcaster-audio/eas.json` and update `submit.production.ios` with your own `appleId`, `ascAppId`, and `appleTeamId` before running `eas submit`.
3. **Provision your own services**: register fresh keys for Neynar, LiveKit, Cloudinary, Deepgram, AWS, Sentry, etc. Never reuse upstream credentials. See the per-app `.env.example` files.
4. **Update bundle identifier and display name**: change `farcaster-audio/app.json` (`expo.ios.bundleIdentifier`, `expo.name`, `expo.slug`) so your build is distinguishable from upstream.

## PR expectations

Before opening a PR:

- [ ] CI is green
- [ ] Tests pass locally for the app(s) you touched (`pytest`, `npx jest`, `npm run build`)
- [ ] Lint passes (`ruff check`, `npm run lint`)
- [ ] For UI changes: include screenshots or a short screen recording

Keep PRs focused. Aim for under 300 lines of diff when possible. Split unrelated work into separate PRs.

## Code review

- Be specific. Point at lines, not vibes.
- Prefer suggestions over demands.
- Approve only after you've actually pulled and run the change for non-trivial PRs.

## Reporting security issues

Do not open a public issue for security vulnerabilities. See [SECURITY.md](./SECURITY.md).
