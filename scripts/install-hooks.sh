#!/usr/bin/env bash
# Activate the repo's version-controlled git hooks (one command, idempotent).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
git -C "$ROOT" config core.hooksPath scripts/git-hooks
chmod +x "$ROOT"/scripts/git-hooks/* 2>/dev/null || true
echo "✓ git hooks active (core.hooksPath = scripts/git-hooks)"
