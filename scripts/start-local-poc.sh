#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

cli_model_provider="${MODEL_PROVIDER:-}"
cli_gemini_key="${GEMINI_API_KEY:-}"
cli_gemini_model="${GEMINI_MODEL:-}"
cli_openrouter_key="${OPENROUTER_API_KEY:-}"
cli_openrouter_model="${OPENROUTER_MODEL:-}"
cli_ark_key="${ARK_API_KEY:-}"
cli_ark_model="${ARK_MODEL:-}"
cli_host="${HOST:-}"
cli_auth_token="${APP_AUTH_TOKEN:-}"

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

is_usable_model_key() {
  [[ -n "$1" && "$1" != replace-* ]]
}

cli_provider_count=0
for key in "$cli_gemini_key" "$cli_openrouter_key" "$cli_ark_key"; do
  if is_usable_model_key "$key"; then
    cli_provider_count=$((cli_provider_count + 1))
  fi
done
if [[ -n "$cli_model_provider" ]]; then
  export MODEL_PROVIDER="$cli_model_provider"
elif (( cli_provider_count > 1 )); then
  printf '[local-poc] Set MODEL_PROVIDER when passing multiple provider credentials.\n' >&2
  exit 2
elif is_usable_model_key "$cli_gemini_key"; then
  export MODEL_PROVIDER=gemini
elif is_usable_model_key "$cli_openrouter_key"; then
  export MODEL_PROVIDER=openrouter
elif is_usable_model_key "$cli_ark_key"; then
  export MODEL_PROVIDER=ark
fi
if [[ -n "$cli_gemini_key" ]]; then export GEMINI_API_KEY="$cli_gemini_key"; fi
if [[ -n "$cli_gemini_model" ]]; then export GEMINI_MODEL="$cli_gemini_model"; fi
if [[ -n "$cli_openrouter_key" ]]; then export OPENROUTER_API_KEY="$cli_openrouter_key"; fi
if [[ -n "$cli_openrouter_model" ]]; then export OPENROUTER_MODEL="$cli_openrouter_model"; fi
if [[ -n "$cli_ark_key" ]]; then export ARK_API_KEY="$cli_ark_key"; fi
if [[ -n "$cli_ark_model" ]]; then export ARK_MODEL="$cli_ark_model"; fi
if [[ -n "$cli_host" ]]; then export HOST="$cli_host"; fi
if [[ -n "$cli_auth_token" ]]; then export APP_AUTH_TOKEN="$cli_auth_token"; fi

if [[ -z "${MODEL_PROVIDER:-}" ]]; then
  configured_provider_count=0
  for key in "${GEMINI_API_KEY:-}" "${OPENROUTER_API_KEY:-}" "${ARK_API_KEY:-}"; do
    if is_usable_model_key "$key"; then
      configured_provider_count=$((configured_provider_count + 1))
    fi
  done
  if (( configured_provider_count > 1 )); then
    printf '[local-poc] Set MODEL_PROVIDER when multiple provider credentials are configured.\n' >&2
    exit 2
  elif is_usable_model_key "${GEMINI_API_KEY:-}"; then
    export MODEL_PROVIDER=gemini
  elif is_usable_model_key "${OPENROUTER_API_KEY:-}"; then
    export MODEL_PROVIDER=openrouter
  elif is_usable_model_key "${ARK_API_KEY:-}"; then
    export MODEL_PROVIDER=ark
  fi
fi


runtime_image="${CONTAINER_RUNTIME_IMAGE:-volc-agent-runtime:local}"
runtime_base_image="${CONTAINER_RUNTIME_BASE_IMAGE:-node:22-bookworm-slim}"
runtime_apt_mirror="${CONTAINER_APT_MIRROR:-}"
runtime_apt_security_mirror="${CONTAINER_APT_SECURITY_MIRROR:-}"
runtime_apt_packages="${CONTAINER_RUNTIME_APT_PACKAGES:-ca-certificates git ripgrep curl}"
codex_sandbox_mode="${CODEX_SANDBOX_MODE:-workspace-write}"

log() {
  printf '[local-poc] %s\n' "$*" >&2
}

engine_works() {
  "$1" info >/dev/null 2>&1
}

detect_engine() {
  if [[ -n "${CONTAINER_ENGINE:-}" ]]; then
    command -v "$CONTAINER_ENGINE" >/dev/null 2>&1 || {
      log "CONTAINER_ENGINE=$CONTAINER_ENGINE was not found."
      return 1
    }
    engine_works "$CONTAINER_ENGINE" || {
      log "$CONTAINER_ENGINE is installed but its service is not running."
      return 1
    }
    printf '%s' "$CONTAINER_ENGINE"
    return
  fi

  if command -v docker >/dev/null 2>&1 && engine_works docker; then
    printf 'docker'
    return
  fi

  if command -v colima >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
    log "Docker is not reachable; starting Colima."
    colima start >&2
    if engine_works docker; then
      printf 'docker'
      return
    fi
  fi

  if command -v podman >/dev/null 2>&1; then
    if ! engine_works podman && [[ "$(uname -s)" == "Darwin" ]]; then
      log "Podman is not reachable; starting its macOS machine."
      podman machine start >&2 || true
    fi
    if engine_works podman; then
      printf 'podman'
      return
    fi
  fi

  log "No running Docker, Colima, or Podman engine was found."
  log "Install one of them, start it, and rerun this command."
  return 1
}

case "${MODEL_PROVIDER:-}" in
  gemini)
    is_usable_model_key "${GEMINI_API_KEY:-}" || {
      log "MODEL_PROVIDER=gemini requires GEMINI_API_KEY."
      exit 2
    }
    ;;
  openrouter)
    is_usable_model_key "${OPENROUTER_API_KEY:-}" && [[ -n "${OPENROUTER_MODEL:-}" ]] || {
      log "MODEL_PROVIDER=openrouter requires OPENROUTER_API_KEY and OPENROUTER_MODEL."
      exit 2
    }
    ;;
  ark)
    is_usable_model_key "${ARK_API_KEY:-}" && [[ -n "${ARK_MODEL:-}" ]] || {
      log "MODEL_PROVIDER=ark requires ARK_API_KEY and ARK_MODEL."
      exit 2
    }
    ;;
  *)
    log "Set MODEL_PROVIDER to gemini, openrouter, or ark with that provider's credentials."
    exit 2
    ;;
esac


command -v node >/dev/null 2>&1 || {
  log "Node.js 22+ is required to run the local control plane."
  exit 2
}

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  log "Node.js 22+ is required; found $(node --version)."
  exit 2
fi

export NODE_ENV=production
export HOST="${HOST:-127.0.0.1}"
auth_token="${APP_AUTH_TOKEN:-}"
if [[ "$HOST" != "127.0.0.1" && "$HOST" != "::1" && "$HOST" != "localhost" ]] \
  && { (( ${#auth_token} < 24 || ${#auth_token} > 128 )) \
    || [[ "$auth_token" == replace-* ]] \
    || [[ ! "$auth_token" =~ ^[A-Za-z0-9._~-]+$ ]]; }; then
  log "A non-loopback production HOST requires a URL-safe APP_AUTH_TOKEN of 24-128 characters."
  log "Run locally without auth: HOST=127.0.0.1 npm run poc"
  log "Or generate a token: APP_AUTH_TOKEN=\"\$(node -e 'process.stdout.write(require(\"node:crypto\").randomBytes(24).toString(\"base64url\"))')\" HOST=$HOST npm run poc"
  exit 2
fi

engine="$(detect_engine)"
log "Using $engine as the Agent Runtime engine."

if [[ ! -d node_modules ]]; then
  log "Installing application dependencies."
  npm ci
fi

if [[ -n "${LOCAL_POC_DATA_ROOT:-}" ]]; then
  local_state_root="$LOCAL_POC_DATA_ROOT"
  export APP_DATA_DIR="$local_state_root/data"
  export AGENT_WORKSPACE_ROOT="$local_state_root/workspaces"
  export CODEX_HOME="$local_state_root/codex-home"
elif [[ "$(uname -s)" == "Darwin" ]]; then
  local_state_root="${HOME}/.volc-agent-launchpad"
  if [[ "${APP_DATA_DIR:-}" == /app* ]]; then unset APP_DATA_DIR; fi
  if [[ "${AGENT_WORKSPACE_ROOT:-}" == /app* ]]; then unset AGENT_WORKSPACE_ROOT; fi
  if [[ "${CODEX_HOME:-}" == /app* ]]; then unset CODEX_HOME; fi
  export APP_DATA_DIR="${APP_DATA_DIR:-$local_state_root/data}"
  export AGENT_WORKSPACE_ROOT="${AGENT_WORKSPACE_ROOT:-$local_state_root/workspaces}"
  export CODEX_HOME="${CODEX_HOME:-$local_state_root/codex-home}"
else
  local_state_root="$repo_dir/.local"
  export APP_DATA_DIR="${APP_DATA_DIR:-$local_state_root/data}"
  export AGENT_WORKSPACE_ROOT="${AGENT_WORKSPACE_ROOT:-$local_state_root/workspaces}"
  export CODEX_HOME="${CODEX_HOME:-$local_state_root/codex-home}"
fi
export RUNTIME_INSTANCE_ID="${RUNTIME_INSTANCE_ID:-local-$(id -u)-$(printf '%s' "$repo_dir" | cksum | awk '{print $1}')}"

mkdir -p "$APP_DATA_DIR" "$AGENT_WORKSPACE_ROOT" "$CODEX_HOME"
log "Persistent state: $local_state_root"
export CONTAINER_USER="${CONTAINER_USER:-$(id -u):$(id -g)}"

log "Building $runtime_image from Dockerfile.runtime (base: $runtime_base_image)."
"$engine" build \
  --file Dockerfile.runtime \
  --build-arg "NODE_IMAGE=$runtime_base_image" \
  --build-arg "DEBIAN_MIRROR=$runtime_apt_mirror" \
  --build-arg "DEBIAN_SECURITY_MIRROR=$runtime_apt_security_mirror" \
  --build-arg "RUNTIME_APT_PACKAGES=$runtime_apt_packages" \
  --tag "$runtime_image" \
  .

log "Checking that the Runtime can bind-mount the configured state directories."
preflight_user_args=(--user "$CONTAINER_USER")
if [[ "$(basename "$engine")" == "podman" ]]; then
  preflight_user_args+=(--userns keep-id)
fi
if ! "$engine" run --rm \
  "${preflight_user_args[@]}" \
  --mount "type=bind,src=$AGENT_WORKSPACE_ROOT,dst=/workspace" \
  --mount "type=bind,src=$CODEX_HOME,dst=/codex-home" \
  "$runtime_image" sh -lc \
    'touch /workspace/.launchpad-write-test /codex-home/.launchpad-write-test && rm /workspace/.launchpad-write-test /codex-home/.launchpad-write-test'; then
  log "The container engine cannot mount $local_state_root."
  log "Set LOCAL_POC_DATA_ROOT to a directory shared with Docker/Colima/Podman."
  exit 2
fi

if [[ "$codex_sandbox_mode" == "workspace-write" ]] \
  && ! "$engine" run --rm "$runtime_image" \
    codex sandbox linux --full-auto -- true >/dev/null 2>&1; then
  log "Codex Landlock is unavailable in this Linux Runtime."
  log "Falling back to danger-full-access inside the disposable container boundary."
  log "Do not mount unrelated secrets or host directories into the Agent Runtime."
  codex_sandbox_mode=danger-full-access
fi

export PORT="${PORT:-3000}"
export CODEX_SANDBOX_MODE="$codex_sandbox_mode"
export RUNTIME_PROVIDER=container
# Agent containers get no route off-box; the authorizing proxy is their only
# path out. Set EGRESS_ENFORCEMENT=off to fall back to plain bridge networking.
export EGRESS_ENFORCEMENT="${EGRESS_ENFORCEMENT:-on}"
export CONTAINER_ENGINE="$engine"
export CONTAINER_RUNTIME_IMAGE="$runtime_image"

cleanup() {
  local container_ids
  container_ids="$($engine ps --all --quiet \
    --filter label=io.codejam.launchpad=agent-runtime \
    --filter "label=io.codejam.instance-id=$RUNTIME_INSTANCE_ID" 2>/dev/null || true)"
  if [[ -n "$container_ids" ]]; then
    log "Removing remaining Agent Runtime containers for $RUNTIME_INSTANCE_ID."
    while IFS= read -r container_id; do
      [[ -n "$container_id" ]] && "$engine" rm --force "$container_id" >/dev/null 2>&1 || true
    done <<<"$container_ids"
  fi
}
trap cleanup EXIT INT TERM

# Recover cleanly after a terminal or server crash from a previous local run.
cleanup

log "Building the local Web and API."
npm run build

log "Open http://localhost:$PORT"
npm start
