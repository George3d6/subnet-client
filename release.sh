#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Bump minor version (y in x.y.z)
CURRENT=$(node -p "require('./package.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
NEW_VERSION="${MAJOR}.$((MINOR + 1)).0"

echo "=== SDK Release: ${CURRENT} → ${NEW_VERSION} ==="

# Update version in package.json
npm version "$NEW_VERSION" --no-git-tag-version

# Commit, tag, and push to GitHub
git add -A
git commit -m "v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push origin main --tags

# Publish to npm
npm publish --access public

echo "=== Released subnet-client@${NEW_VERSION} ==="
