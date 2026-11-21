ARG NODE_IMAGE=node:22.23.5-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY pc-mobius/package*.json pc-mobius/
COPY web-dashboard/package*.json web-dashboard/
RUN npm --prefix pc-mobius ci && npm --prefix web-dashboard ci
COPY pc-mobius pc-mobius
COPY web-dashboard web-dashboard
COPY docs docs
COPY contracts contracts
COPY deployment/mqtt-bridge.mjs deployment/mqtt-bridge.mjs
COPY deployment/provision-cse.mjs deployment/provision-cse.mjs
ARG VITE_MAP_TILE_URL=
ARG VITE_MAP_ATTRIBUTION=
ARG VITE_STADIA_MAPS_KEY=
ARG VITE_STADIA_MAPS_DOMAIN=
ENV VITE_MAP_TILE_URL=${VITE_MAP_TILE_URL} VITE_MAP_ATTRIBUTION=${VITE_MAP_ATTRIBUTION} VITE_STADIA_MAPS_KEY=${VITE_STADIA_MAPS_KEY} VITE_STADIA_MAPS_DOMAIN=${VITE_STADIA_MAPS_DOMAIN}
RUN npm --prefix web-dashboard run build
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
CMD ["node", "pc-mobius/scripts/run-integration-api.mjs"]
