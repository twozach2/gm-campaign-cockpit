FROM node:20.12-alpine

WORKDIR /app
COPY package.json ./
COPY lib ./lib
COPY public ./public
COPY relay ./relay

RUN mkdir -p /data/assets && chown -R node:node /app /data

USER node
ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8787 \
    RELAY_STATE_FILE=/data/relay.json \
    RELAY_ASSET_DIR=/data/assets

VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/readiness').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "relay/server.mjs"]
