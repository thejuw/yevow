# Hyperliquid gRPC Protobufs

Place provider-supplied Hyperliquid `.proto` files in this directory, then run:

```sh
npm run proto:compile
```

The compiler emits `src/types/grpc/hyperliquid.ts`, which is bundled into the
Cloudflare Worker. `dwellir_l1_gateway.proto` is based on Dwellir's published
Hyperliquid L1 Gateway service definition.

Dwellir runtime settings:

- `INGEST_TRANSPORT=grpc`
- `DWELLIR_GRPC_URL` as a Wrangler secret when Dwellir supplies a private UUID route
- `DWELLIR_GRPC_ENDPOINT=https://api-hyperliquid-mainnet-grpc.n.dwellir.com` as a compatibility alias
- `DWELLIR_API_KEY` as a Wrangler secret only when Dwellir supplies a separate API key
- `RPC_GRPC_SERVICE=hyperliquid_l1_gateway.v2.HyperliquidL1Gateway`
- `DWELLIR_GRPC_STREAMS=ORDERBOOK_SNAPSHOT,FILLS`
- `HL_GRPC_BACKOFF_BASE_MS=50`
- `DWELLIR_GRPC_FATAL_DROP_MS=200`

Note: Dwellir's documented gRPC payloads currently wrap Hyperliquid book/fill
data as JSON-encoded `bytes`. The ingest worker only parses the target market
tuples from order-book snapshots to avoid materializing the full snapshot.
