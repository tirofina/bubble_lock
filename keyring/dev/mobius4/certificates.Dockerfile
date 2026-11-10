FROM alpine:3.21
RUN apk add --no-cache openssl
COPY generate-certificates.sh /generate-certificates.sh
ENTRYPOINT ["/bin/sh", "/generate-certificates.sh"]
