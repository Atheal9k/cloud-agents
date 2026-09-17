# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2

FROM ${NODE_IMAGE} AS build

ARG T3CODE_SOURCE_REVISION

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential git python3 \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

WORKDIR /source
COPY . .

RUN printf '%s' "${T3CODE_SOURCE_REVISION}" | grep -Eq '^[0-9a-f]{40}$' \
    || (echo 'T3CODE_SOURCE_REVISION must be the full 40-character Git commit.' >&2; exit 1)

RUN --mount=type=cache,id=t3-controller-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --filter @t3tools/monorepo --filter 't3...' --filter '@t3tools/desktop...' --frozen-lockfile \
    && pnpm exec vp run --filter t3 build \
    && pnpm --config.allowUnusedPatches=true --filter t3 deploy --prod --legacy /opt/t3

FROM ${NODE_IMAGE} AS controller

ARG T3CODE_SOURCE_REVISION
ARG T3CODE_IMAGE_VERSION=0.0.42

LABEL org.opencontainers.image.title="T3 Code controller" \
      org.opencontainers.image.description="Production T3 Code server and web client" \
      org.opencontainers.image.source="https://github.com/Atheal9k/cloud-agents" \
      org.opencontainers.image.revision="${T3CODE_SOURCE_REVISION}" \
      org.opencontainers.image.version="${T3CODE_IMAGE_VERSION}"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git openssh-client tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 t3 \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin t3 \
    && install -d -o t3 -g t3 /var/lib/t3 /workspace /run/t3-credentials

COPY --from=build --chown=t3:t3 /opt/t3 /opt/t3
COPY --chown=root:root packaging/docker/controller-entrypoint.sh /usr/local/bin/t3-controller-entrypoint
RUN chmod 0755 /usr/local/bin/t3-controller-entrypoint

ENV NODE_ENV=production \
    T3CODE_HOME=/var/lib/t3 \
    T3CODE_HOST=0.0.0.0 \
    T3CODE_PORT=3777 \
    T3CODE_NO_BROWSER=1 \
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0 \
    T3CODE_CLOUD_CONTROLLER=1

WORKDIR /workspace
USER 10001:10001

EXPOSE 3777
VOLUME ["/var/lib/t3"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3777/').then(r=>{if(!r.ok)throw new Error(String(r.status))}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/t3-controller-entrypoint"]
CMD ["serve"]
