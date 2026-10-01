# WhatsApp QR gateway image (services/wa-gateway). Build context = this folder (see deploy/local-windows/docker-compose.yml).
FROM node:22-alpine AS build
WORKDIR /gw
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /gw
# GATEWAY_BIND=0.0.0.0: inside a container loopback would be unreachable from
# the app container; the port is only exposed on the Docker network.
ENV NODE_ENV=production WA_DATA_DIR=/data GATEWAY_BIND=0.0.0.0
RUN apk add --no-cache socat
COPY --from=build /gw/node_modules ./node_modules
COPY --from=build /gw/dist ./dist
COPY --from=build /gw/package.json ./package.json
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
VOLUME ["/data"]
EXPOSE 3201
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
