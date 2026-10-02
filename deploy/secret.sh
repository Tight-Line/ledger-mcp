#!/usr/bin/env bash
#
# Create or update the Secret a deployment reads its credentials from.
#
#   deploy/secret.sh path/to/values.yaml
#
# Prompts for each credential without echoing it. Press Enter to keep the value already in the
# cluster. A value can also come from the environment under the same name, e.g.
#   OIDC_CLIENT_SECRET=... deploy/secret.sh <values-file>
#
# Nothing is written to disk: the Secret is built in memory and piped to kubectl. SEAL_KEY is
# generated once and then kept, because changing it signs every user out of every client and
# invalidates every token this server has issued -- which is also how to do that deliberately:
#   ROTATE_SEAL_KEY=1 deploy/secret.sh <values-file>
set -euo pipefail

values=${1:?usage: $(basename "$0") <values-file>}
context=$(awk '/^kubeContext:/{print $2}' "$values")
namespace=$(awk '/^namespace:/{print $2}' "$values")
secret=$(awk '/^existingSecret:/{print $2}' "$values")
secret=${secret:-ledger-mcp}
[ -n "$context" ] && [ -n "$namespace" ] || { echo "$values must set kubeContext and namespace" >&2; exit 64; }

k() { kubectl --context "$context" -n "$namespace" "$@"; }

existing() {
  k get secret "$secret" -o "jsonpath={.data.$1}" 2>/dev/null | base64 -d 2>/dev/null || true
}

# Plain variables named v_<KEY> rather than an associative array, which needs bash 4 and macOS
# ships 3.2 as /bin/bash.
KEYS="SEAL_KEY OIDC_CLIENT_ID OIDC_CLIENT_SECRET QUICKBOOKS_CLIENT_ID QUICKBOOKS_CLIENT_SECRET"
for key in OIDC_CLIENT_ID OIDC_CLIENT_SECRET QUICKBOOKS_CLIENT_ID QUICKBOOKS_CLIENT_SECRET; do
  current=$(existing "$key")
  if [ -n "${!key:-}" ]; then
    entered=${!key}
  else
    hint=$([ -n "$current" ] && echo " [Enter keeps the current value]" || echo "")
    read -rsp "$key$hint: " entered </dev/tty; echo >&2
  fi
  printf -v "v_$key" '%s' "${entered:-$current}"
  name="v_$key"
  [ -n "${!name}" ] || { echo "$key is required" >&2; exit 65; }
done

v_SEAL_KEY=$(existing SEAL_KEY)
if [ -z "$v_SEAL_KEY" ] || [ -n "${ROTATE_SEAL_KEY:-}" ]; then
  v_SEAL_KEY=$(openssl rand -base64 32)
  echo "generated a new SEAL_KEY" >&2
fi

k get namespace "$namespace" >/dev/null 2>&1 || kubectl --context "$context" create namespace "$namespace"

env_file() { for key in $KEYS; do name="v_$key"; printf '%s=%s\n' "$key" "${!name}"; done; }
k create secret generic "$secret" --from-env-file=<(env_file) --dry-run=client -o yaml | k apply -f -
echo "$context/$namespace secret/$secret has: $(k get secret "$secret" -o jsonpath='{.data}' | tr -d '{}"' | tr ',' '\n' | cut -d: -f1 | sort | tr '\n' ' ')" >&2
