#!/usr/bin/env bash
# Kept so existing instructions and muscle memory keep working. The logic lives
# in bootstrap-local.mjs, which runs on Windows too -- this path cannot, and the
# APP_AUTH_TOKEN error it resolves is the first thing a Compose user hits.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bootstrap-local.mjs" "$@"
