#!/bin/sh
set -eu
cd /output
test ! -e ca.key && test ! -e ca.pem
umask 077
openssl req -x509 -newkey rsa:3072 -nodes -days 90 -keyout ca.key -out ca.pem \
  -subj /CN=Privacy-Bubble-Scoped-Dev-CA >/dev/null 2>&1

issue() {
  filename=$1
  common_name=$2
  openssl req -new -newkey rsa:3072 -nodes -keyout "$filename.key" -out "$filename.csr" \
    -subj "/CN=$common_name" >/dev/null 2>&1
  openssl x509 -req -in "$filename.csr" -CA ca.pem -CAkey ca.key -CAcreateserial \
    -days 30 -out "$filename.pem" -extfile "$filename.ext" >/dev/null 2>&1
}

printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:broker,DNS:tls\nextendedKeyUsage=serverAuth\n' > server.ext
issue server localhost
for entry in 'client scoped-core' 'gateway-a scoped-gateway-a' 'gateway-b scoped-gateway-b'; do
  set -- $entry
  printf 'extendedKeyUsage=clientAuth\n' > "$1.ext"
  issue "$1" "$2"
done
# The private directory is host-local. Bind only the needed key into each container.
chmod 644 ca.pem server.pem server.key client.pem client.key gateway-a.pem gateway-b.pem
chmod 600 ca.key gateway-a.key gateway-b.key
