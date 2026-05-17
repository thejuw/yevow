# Hyperliquid gRPC Proto Provenance

`dwellir_l1_gateway.proto` captures the Dwellir Hyperliquid L1 Gateway service
surface used by Sovereign-Sigma:

- `StreamBlocks(Position)`
- `StreamFills(Position)`
- `StreamOrderbookSnapshots(Position)`
- `GetBlock(Position)`
- `GetFills(Position)`
- `GetOrderBookSnapshot(Timestamp)`

The Dwellir public Hyperliquid documentation describes the L1 gRPC Gateway as
the stream path for HyperCore blocks, fills, and order-book snapshots. It also
documents the order-book service as supporting L2 and L4 depth. The current
gateway messages expose the vendor payload as protobuf `bytes`; the engine
therefore treats the protobuf frame as authoritative transport and performs the
minimum required byte-payload decode for target-market tuples.

Dwellir documents `StreamOrderbookSnapshots` as a premium dedicated-node
endpoint. Shared/Enterprise production routes therefore keep fills on the gRPC
gateway and hydrate L4 book state through Dwellir's order-book server. Dedicated
routes can set `DWELLIR_SUBSCRIPTION_TIER=DEDICATED` and
`DWELLIR_ORDERBOOK_TRANSPORT=grpc` to use gRPC book snapshots directly.

If Dwellir provides a revised schema package, replace or add the `.proto` files
in this directory and run:

```sh
npm run proto:compile
```

The compiler is fail-closed: no placeholder descriptor will be generated if the
provider schema files are missing.
