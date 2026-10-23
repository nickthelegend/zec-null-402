# syntax=docker/dockerfile:1
# Kippu gateway image: credits viewing-key-checked shielded deposits, verifies per-call Groth16 proofs.
# Multi-stage: the Rust scan binary on the pinned toolchain, TypeScript build with pnpm, run on node slim.
# No secrets are baked in; there is no wallet in the image, so anchoring answers Setup required.
FROM rust:1.89-bookworm AS scan
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} CARGO_TERM_COLOR=never
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY packages/scan ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/zpay-verify /zpay-verify

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/circuits/package.json packages/circuits/
COPY packages/gateway/package.json packages/gateway/
RUN pnpm install --frozen-lockfile --filter "@z402/gateway..."
COPY packages/circuits packages/circuits
COPY packages/gateway packages/gateway
RUN pnpm --filter @z402/circuits build && pnpm --filter @z402/gateway build \
 && pnpm install --frozen-lockfile --prod --filter "@z402/gateway..."

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production Z402_SCAN_BIN=/usr/local/bin/zpay-verify Z402_HOST=0.0.0.0 Z402_PORT=8405 \
    Z402_STATE=/data/z402.sqlite
COPY --from=scan /zpay-verify /usr/local/bin/zpay-verify
WORKDIR /app
COPY --from=build /app ./
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 8405
CMD ["node", "packages/gateway/dist/serve.js"]
