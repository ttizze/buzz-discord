#!/usr/bin/env bash
set -euo pipefail

: "${BUZZCODE_OIDC_ISSUER:?BUZZCODE_OIDC_ISSUER is required}"
: "${BUZZCODE_API_ORIGIN:?BUZZCODE_API_ORIGIN is required}"

metadata="$(curl --fail --silent --show-error "${BUZZCODE_OIDC_ISSUER%/}/.well-known/openid-configuration")"
jq -e --arg issuer "${BUZZCODE_OIDC_ISSUER%/}" '
  .issuer == $issuer and
  (.authorization_endpoint | type == "string") and
  (.token_endpoint | type == "string") and
  (.jwks_uri | type == "string") and
  (.code_challenge_methods_supported | index("S256") != null)
' <<<"$metadata" >/dev/null

authorization_endpoint="$(jq -r .authorization_endpoint <<<"$metadata")"
location="$(curl --silent --show-error --output /dev/null --write-out '%{redirect_url}' "${BUZZCODE_API_ORIGIN%/}/api/auth/login")"
case "$location" in
  "$authorization_endpoint"*) ;;
  *)
    echo "Buzzcode did not redirect to the configured Rauthy authorization endpoint" >&2
    exit 1
    ;;
esac

echo "Rauthy discovery, S256 support, and Buzzcode authorization redirect are ready."
