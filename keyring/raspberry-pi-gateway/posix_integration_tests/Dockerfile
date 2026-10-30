# Use the already cached development image; never run its PKI generation entrypoint.
FROM privacy-bubble-keyring-dev-certificates:local
RUN apk add --no-cache python3 py3-pip
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /work
USER 65532:65532
ENTRYPOINT ["/usr/bin/python3"]
