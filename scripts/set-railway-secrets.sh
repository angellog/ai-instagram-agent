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

# Sanity-check an Instagram token before shipping it: it must work and belong to the given account id.
tok=$(grep -E "^INSTAGRAM_ACCESS_TOKEN=" "$tmp" | tail -1 | cut -d= -f2- || true)
if [[ -n "$tok" ]]; then
  me=$(curl -s -H "Authorization: Bearer $tok" "https://graph.instagram.com/v25.0/me?fields=user_id,username,account_type")
  uid=$(printf '%s' "$me" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('user_id',''))" 2>/dev/null || true)
  uname=$(printf '%s' "$me" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('username',''), d.get('account_type',''))" 2>/dev/null || true)
  [[ -z "$uid" ]] && { echo "✗ Instagram token rejected by Meta: $me" >&2; exit 1; }
  echo "  token OK for @$uname (user_id $uid)"
  given=$(grep -E "^INSTAGRAM_ACCOUNT_ID=" "$tmp" | tail -1 | cut -d= -f2- || true)
  if [[ -z "$given" ]]; then echo "INSTAGRAM_ACCOUNT_ID=$uid" >> "$tmp"; echo "  INSTAGRAM_ACCOUNT_ID filled in from the token"
  elif [[ "$given" != "$uid" ]]; then echo "✗ INSTAGRAM_ACCOUNT_ID $given does not match the token's account ($uid)" >&2; exit 1; fi
fi

args=()
for k in "${KEYS[@]}"; do
  v=$(grep -E "^$k=" "$tmp" | tail -1 | cut -d= -f2- || true)
  [[ -n "$v" ]] && args+=(--set "$k=$v") && echo "  will set $k"
done
[[ ${#args[@]} -eq 0 ]] && { echo "nothing to set"; exit 1; }
# --skip-deploys + explicit redeploy: variable changes alone don't rebuild a
# service whose GitHub source Railway can't reach.
for s in web worker; do
  railway variables --service "$s" --skip-deploys "${args[@]}" >/dev/null && echo "✓ $s variables set"
  railway redeploy --service "$s" --yes >/dev/null && echo "✓ $s redeploy started"
done
