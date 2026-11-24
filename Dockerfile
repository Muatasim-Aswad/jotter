# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS web-build
WORKDIR /src
RUN npm install --global pnpm@10.34.5
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

FROM golang:1.27.4-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS server-build
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

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runtime
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
