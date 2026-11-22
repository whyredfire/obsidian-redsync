FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/redsync-server /redsync-server

FROM gcr.io/distroless/cc-debian12
COPY --from=build /redsync-server /redsync-server
EXPOSE 8080
ENTRYPOINT ["/redsync-server"]
