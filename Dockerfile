# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS web-build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY packages/protocol packages/protocol
COPY apps/web apps/web
COPY scripts/release/web-notices.mjs scripts/release/web-notices.mjs
# Release identity is optional; builds without it report dev because .git is excluded.
ARG APP_VERSION APP_REVISION APP_COMMIT_TIME APP_BUILD_TIME SOURCE_DATE_EPOCH
RUN pnpm --filter @jotter/web build

FROM golang:1.27.1-alpine@sha256:4cb7ac979db5fcc41cae44b2227ba5ab8a51e8807f40d9ba4dee20a0ad960b5b AS server-build
WORKDIR /src/apps/server
COPY apps/server/go.mod apps/server/go.sum ./
RUN go mod download
COPY apps/server ./
COPY scripts/release/go-notices.go /src/scripts/release/go-notices.go
COPY --from=web-build /src/apps/web/dist ./internal/webassets/dist
ENV GOTOOLCHAIN=local
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -mod=readonly -buildvcs=false -trimpath -ldflags="-s -w" -o /out/jotter ./cmd/jotter
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go run /src/scripts/release/go-notices.go > /out/DEPENDENCY-NOTICES.txt \
    && cat internal/webassets/dist/licenses.txt >> /out/DEPENDENCY-NOTICES.txt

FROM alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1 AS runtime
RUN addgroup -S -g 10001 jotter \
    && adduser -S -D -H -u 10001 -G jotter jotter \
    && sed -i 's/^jotter:[^:]*:[^:]*:/jotter:!:0:/' /etc/shadow \
    && rm -f /etc/group- /etc/passwd- /etc/shadow- /etc/gshadow- \
    && install -d -m 0700 -o jotter -g jotter /data
COPY --from=server-build --chown=10001:10001 --chmod=0555 /out/jotter /usr/local/bin/jotter
COPY --chmod=0444 LICENSE /usr/share/licenses/jotter/LICENSE
COPY --from=server-build --chmod=0444 /out/DEPENDENCY-NOTICES.txt /usr/share/licenses/jotter/DEPENDENCY-NOTICES.txt
ENV JOTTER_ENV=production \
    JOTTER_LISTEN_ADDR=0.0.0.0:8080 \
    JOTTER_DATA_DIR=/data \
    JOTTER_LOG_LEVEL=info
ARG APP_VERSION APP_COMMIT_TIME APP_BUILD_TIME
ARG APP_REVISION=dev
LABEL org.opencontainers.image.source="https://github.com/Muatasim-Aswad/jotter" \
    org.opencontainers.image.version="$APP_VERSION" \
    org.opencontainers.image.revision="$APP_REVISION" \
    org.opencontainers.image.created="$APP_BUILD_TIME"
USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/health/ready || exit 1
ENTRYPOINT ["/usr/local/bin/jotter"]
