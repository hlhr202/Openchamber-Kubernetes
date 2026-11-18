FROM --platform=linux/amd64 node:24.22.1-bookworm-slim@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae

# Bootstrap ONLY pnpm in this isolated image. No project dependencies use npm.
# Both lifecycle hooks are blocked; the reviewed Linux linker is invoked once explicitly.
ENV HOME=/home/node \
    NPM_CONFIG_USERCONFIG=/opt/npm-user.npmrc \
    NPM_CONFIG_GLOBALCONFIG=/opt/npm-global.npmrc \
    NPM_CONFIG_CACHE=/opt/npm-cache \
    COREPACK_ENABLE_NETWORK=0 \
    PNPM_CONFIG_PM_ON_FAIL=error \
    PNPM_CONFIG_RUNTIME_ON_FAIL=error
RUN touch /opt/npm-user.npmrc /opt/npm-global.npmrc \
    && npm install --global --ignore-scripts --no-audit --no-fund pnpm@12.15.0 \
    && node /usr/local/lib/node_modules/pnpm/install.js \
    && test "$(pnpm --version)" = '12.15.0'

RUN mkdir -p /workspace/node_modules /workspace/.build /pnpm/store /home/node/.cache \
    && chown -R node:node /workspace /pnpm /home/node /opt/npm-cache
USER node
WORKDIR /workspace
ENV OPENCHAMBER_K8S_DEVELOPMENT=1 \
    XDG_CONFIG_HOME=/home/node/.config \
    XDG_CACHE_HOME=/home/node/.cache \
    XDG_DATA_HOME=/home/node/.local/share
# No service, installer, bootstrap, session restoration, healthcheck or cleanup hook.
ENTRYPOINT []
CMD ["node", "--version"]
