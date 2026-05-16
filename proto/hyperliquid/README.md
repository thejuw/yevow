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
- `DWELLIR_GRPC_ENDPOINT=https://api-hyperliquid-mainnet-grpc.n.dwellir.com`
- `DWELLIR_API_KEY` as a Wrangler secret
- `RPC_GRPC_SERVICE=hyperliquid_l1_gateway.v2.HyperliquidL1Gateway`
- `DWELLIR_GRPC_STREAMS=ORDERBOOK_SNAPSHOT,FILLS,BLOCK`

Note: Dwellir's documented gRPC payloads currently wrap Hyperliquid book/fill
data as JSON-encoded `bytes`. The ingest worker only parses the target market
tuples from order-book snapshots to avoid materializing the full snapshot.
