# WhatsApp QR gateway image (services/wa-gateway). Build context = this folder (see deploy/local-windows/docker-compose.yml).
FROM node:22-alpine AS build
WORKDIR /gw
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /gw
ENV NODE_ENV=production WA_DATA_DIR=/data
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
