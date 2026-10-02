#!/usr/bin/env bash
#
# Deploy, or upgrade, a ledger-mcp release.
#
#   deploy/deploy.sh path/to/values.yaml [sha-abc1234]
#
# The values file names the cluster (kubeContext) and namespace as well as the chart values. The
# image tag comes from the second argument, or image.tag in the values file.
#
# `--wait=legacy`, not `--wait`: Helm 4's default `watcher` strategy can sit idle for the whole
# timeout before applying anything, with the release stuck in pending-install and nothing
# created. `legacy` polls, as Helm 3 did.
set -euo pipefail

values=${1:?usage: $(basename "$0") <values-file> [image-tag]}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
context=$(awk '/^kubeContext:/{print $2}' "$values")
namespace=$(awk '/^namespace:/{print $2}' "$values")
public_url=$(awk '/^publicUrl:/{print $2}' "$values")
tag=${2:-$(awk '/^  tag: /{gsub(/"/, "", $2); print $2}' "$values")}
repository=$(awk '/^  repository: /{print $2}' "$root/deploy/helm/ledger-mcp/values.yaml")

[ -n "$context" ] && [ -n "$namespace" ] || { echo "$values must set kubeContext and namespace" >&2; exit 64; }
[ -n "$tag" ] || { echo "no image tag: pass one, or set image.tag in $values" >&2; exit 64; }

# Anonymously pullable, or the pod is an ImagePullBackOff with no useful message. GHCR does not
# always give a package the repository's visibility.
if ! docker manifest inspect "$repository:$tag" >/dev/null 2>&1; then
  echo "$repository:$tag is not pullable. Has the Release workflow finished, and is the package public?" >&2
  exit 69
fi

# The Secret is not the chart's, so check it is complete before the pod finds out the hard way.
for key in SEAL_KEY OIDC_CLIENT_ID OIDC_CLIENT_SECRET QUICKBOOKS_CLIENT_ID QUICKBOOKS_CLIENT_SECRET; do
  if [ -z "$(kubectl --context "$context" -n "$namespace" get secret ledger-mcp -o "jsonpath={.data.$key}" 2>/dev/null)" ]; then
    echo "secret/ledger-mcp in $context/$namespace has no $key. Run deploy/secret.sh $values first." >&2
    exit 65
  fi
done

echo "==> $context/$namespace to $repository:$tag"
helm --kube-context "$context" -n "$namespace" upgrade --install ledger-mcp \
  "$root/deploy/helm/ledger-mcp" -f "$values" --set "image.tag=$tag" \
  --wait=legacy --timeout 5m

echo "==> running: $(kubectl --context "$context" -n "$namespace" get deploy ledger-mcp -o jsonpath='{.spec.template.spec.containers[0].image}')"
kubectl --context "$context" -n "$namespace" logs deploy/ledger-mcp | grep '"event":"listening"' | tail -1

# Through the real front door, from here. A pod that is Ready proves the process started; this
# proves the name, the certificate, the proxy and the ingress class all agree.
if [ -n "$public_url" ]; then
  for path in /healthz /eula /privacy; do
    printf '==> %s%s %s\n' "$public_url" "$path" "$(curl -s -o /dev/null -w '%{http_code}' "$public_url$path")"
  done
fi
