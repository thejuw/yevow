# Hyperliquid gRPC Protobufs

Place the provider-supplied Hyperliquid `.proto` files in this directory, then run:

```sh
npm run proto:compile
```

The compiler emits `src/types/grpc/hyperliquid.ts`, which is bundled into the
Cloudflare Worker. This repository does not fabricate an "official" Hyperliquid
gRPC schema because Hyperliquid's public documentation exposes the native JSON
WebSocket API, while gRPC access is provider-specific.

Required runtime settings for gRPC mode:

- `INGEST_TRANSPORT=grpc`
- `RPC_GRPC_ENDPOINT=https://<provider-host>/<optional-base-path>`
- `RPC_AUTH_TOKEN` as a Wrangler secret
- `RPC_GRPC_SERVICE`, for example `hyperliquid.Streaming`
- `RPC_GRPC_STREAM_METHOD`, for example `StreamData`
- `RPC_GRPC_SUBSCRIBE_TYPE`, for example `hyperliquid.SubscribeRequest`
- `RPC_GRPC_UPDATE_TYPE`, for example `hyperliquid.SubscribeUpdate`

If the provider exposes a specialized binary order-book service such as
`StreamL2Book`, add its proto here and configure a dedicated stream in
`MARKET_STREAMS`.
