#!/usr/bin/env sh

# Release homestead to npm: verify, bump the version, publish, push.
#
#   bun run release            # patch  (0.1.0 -> 0.1.1)
#   bun run release minor      # minor  (0.1.0 -> 0.2.0)
#   bun run release major      # major  (0.1.0 -> 1.0.0)
#   bun run release 1.4.0      # explicit version
#
# 2FA: npm prompts for a one-time password interactively. To pass it through
# non-interactively, set NPM_OTP:
#   NPM_OTP=123456 bun run release
#
# DRY_RUN=1 walks every step (incl. `npm publish --dry-run`) without bumping,
# publishing, or pushing.

set -eu

bump="${1:-patch}"
dry="${DRY_RUN:-}"

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# 1. Guardrails — release only from a clean `main`.
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || die "on '$branch', not 'main' — refusing to release"
[ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit or stash first"
npm whoami >/dev/null 2>&1 || die "not logged in to npm — run 'npm login'"

# 2. Verify before burning a version number.
step "config-types up to date"
bun run gen:config-types --check
step "typecheck"
bun run typecheck
step "test"
bun test

if [ -n "$dry" ]; then
  step "publish (dry run)"
  # The real flow bumps the version first; here we pack the *current* version, so
  # npm's "cannot publish over an existing version" is expected and not a failure.
  npm publish --dry-run || echo "  (publish-over-existing-version warning is expected in a dry run)"
  printf '\n\033[1;32m✓ dry run clean — would bump (%s), publish, and push\033[0m\n' "$bump"
  exit 0
fi

# 3. Bump the version (writes package.json, makes a commit + tag).
step "version bump ($bump)"
new=$(npm version "$bump" -m "release: v%s")
printf '  -> %s\n' "$new"

# Re-stamp the generated config types with the new version and fold the change
# into the version commit (and its tag) so the published artifact is accurate.
step "re-stamp config types"
bun run gen:config-types
if [ -n "$(git status --porcelain src/homestead.config.types.d.ts)" ]; then
  git add src/homestead.config.types.d.ts
  git commit --amend --no-edit
  git tag -f "$new" -m "release: $new"
fi

# 4. Publish (npm runs `prepare`; OTP prompts unless NPM_OTP is set).
step "publish"
if [ -n "${NPM_OTP:-}" ]; then
  npm publish --otp "$NPM_OTP"
else
  npm publish
fi

# 5. Push the release commit + tag (and any other pending commits).
step "push"
git push --follow-tags

printf '\n\033[1;32m✓ released homestead %s\033[0m\n' "$new"
