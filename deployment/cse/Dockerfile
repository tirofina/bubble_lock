FROM node:24.22.3-bookworm-slim AS build
WORKDIR /app
COPY deployment/cse/artifacts/mobius4-*-bubble-subscription-v2.tar.gz /tmp/mobius.tar.gz
RUN tar xzf /tmp/mobius.tar.gz -C /app \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && rm /tmp/mobius.tar.gz

FROM node:24.22.3-bookworm-slim
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /var/lib/mobius4 && chown node:node /var/lib/mobius4
USER node
ENV NODE_ENV=production
VOLUME ["/var/lib/mobius4"]
EXPOSE 7599
ENTRYPOINT ["node", "docker/entrypoint.js"]
