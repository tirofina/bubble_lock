#!/bin/sh
# Run from the repository root after approval and first HTTP-01 issuance.
set -eu
: "${PUBLIC_DOMAIN:?Set the approved public hostname}"
docker compose -f deployment/compose.yaml --profile tools run --rm certbot renew --webroot -w /var/www/acme
docker compose -f deployment/compose.yaml --profile tools run --rm cert-install
docker compose -f deployment/compose.yaml restart proxy
