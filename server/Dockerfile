FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev build-base perl cmake ca-certificates
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/redsync-server /redsync-server

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /redsync-server /usr/local/bin/redsync-server
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/redsync-server"]
