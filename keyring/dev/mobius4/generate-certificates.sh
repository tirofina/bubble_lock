#!/bin/sh
set -eu
cd /output
# Refuse overwrites. CA rotation must not silently invalidate enrolled peers.
test ! -e ca.key && test ! -e client.key && test ! -e server.key
umask 077
openssl req -x509 -newkey rsa:3072 -nodes -days 90 -keyout ca.key -out ca.pem -subj /CN=Privacy-Bubble-Local-Dev-CA >/dev/null 2>&1
openssl req -new -newkey rsa:3072 -nodes -keyout server.key -out server.csr -subj /CN=localhost >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:broker\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 30 -out server.pem -extfile server.ext >/dev/null 2>&1
openssl req -new -newkey rsa:3072 -nodes -keyout client.key -out client.csr -subj /CN=keyring-dev-gateway >/dev/null 2>&1
printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key -CAserial ca.srl -days 30 -out client.pem -extfile client.ext >/dev/null 2>&1
# Server/broker containers need read access. Host .local directory remains private.
chmod 644 ca.pem server.pem server.key client.pem
chmod 600 ca.key client.key
printf 'Development certificate files created; private material was not printed.\n'
