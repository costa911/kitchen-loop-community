# The Kitchen Loop — Community Edition
# Pinned by digest (multi-arch index for node:22.23.4-alpine) so every build uses the same base.
FROM docker.io/library/node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

# No npm install step: the app uses Node.js built-in modules only.
COPY --chown=root:root server.js package.json LICENSE ./
COPY --chown=root:root lib ./lib
COPY --chown=root:root public ./public
COPY --chown=root:root seed ./seed

# /data is owned by the unprivileged `node` user so a new named volume inherits that
# ownership. Application code stays root-owned and read-only to the running process.
RUN mkdir /data && chown node:node /data && chmod 700 /data

USER node
EXPOSE 8080
VOLUME ["/data"]

CMD ["node", "server.js"]
