#!/usr/bin/env bash
# Push operator credentials to both Railway services (web + worker).
#
#   scripts/set-railway-secrets.sh path/to/secrets.env   # KEY=value lines
#   scripts/set-railway-secrets.sh --from-feetbit        # reuse keys from sibling FeetBit projects
#
# Only the keys below are sent. Values never touch git or the terminal output.
set -euo pipefail
cd "$(dirname "$0")/.."

KEYS=(LLM_API_KEY LLM_PROVIDER LLM_BASE_URL LLM_MODEL LLM_FAST_MODEL KIE_API_KEY KIE_API_KEY_2 KIE_API_KEY_3
      SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_BUCKET IMGBB_API_KEY
      INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET FACEBOOK_APP_SECRET INSTAGRAM_ACCOUNT_ID INSTAGRAM_ACCESS_TOKEN
      TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID OPENREPLY_DEFER_KEYWORDS)

tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
if [[ "${1:-}" == "--from-feetbit" ]]; then
  get() { [[ -f "$1" ]] && grep -E "^$2=" "$1" | tail -1 | cut -d= -f2- || true; }
  P=~/Projects
  { echo "KIE_API_KEY=$(get $P/kickshot/.env KIE_API_KEY)"
    echo "KIE_API_KEY_2=$(get $P/kickshot/.env KIE_API_KEY_2)"
    echo "KIE_API_KEY_3=$(get $P/kickshot/.env KIE_API_KEY_3)"
    echo "SUPABASE_URL=$(get $P/kickshot/.env SUPABASE_URL)"
    echo "SUPABASE_SERVICE_ROLE_KEY=$(get $P/kickshot/.env SUPABASE_SERVICE_ROLE_KEY)"
    echo "IMGBB_API_KEY=$(get $P/kickshot/.env IMGBB_API_KEY)"
    echo "LLM_API_KEY=$(get $P/telegram-agents/.env ANTHROPIC_API_KEY)"
  } > "$tmp"
  [[ -f "${2:-}" ]] && cat "$2" >> "$tmp"
elif [[ -f "${1:-}" ]]; then
  cp "$1" "$tmp"
else
  echo "usage: $0 <secrets.env> | --from-feetbit [extra.env]" >&2; exit 1
fi

args=()
for k in "${KEYS[@]}"; do
  v=$(grep -E "^$k=" "$tmp" | tail -1 | cut -d= -f2- || true)
  [[ -n "$v" ]] && args+=(--set "$k=$v") && echo "  will set $k"
done
[[ ${#args[@]} -eq 0 ]] && { echo "nothing to set"; exit 1; }
for s in web worker; do railway variables --service "$s" "${args[@]}" >/dev/null && echo "✓ $s updated (redeploying)"; done
