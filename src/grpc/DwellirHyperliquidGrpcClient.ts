import * as protobuf from "protobufjs";
import { appendGrpcChunk, assertGrpcOk, encodeGrpcFrame } from "./GrpcFrame";
import {
  hasHyperliquidGrpcDescriptor,
  hyperliquidGrpcDescriptor,
  hyperliquidGrpcGeneratedAt,
  hyperliquidGrpcProtoFiles
} from "../types/grpc/hyperliquid";
import type { JsonRecord } from "../types";

export type DwellirGrpcStreamKind = "BLOCK" | "FILLS" | "ORDERBOOK_SNAPSHOT";

export interface DwellirGrpcClientConfig {
  endpoint: string;
  apiKey?: string | null;
  service: string;
  startTimestampMs?: number | null;
  startBlockHeight?: number | null;
}

export interface DwellirGrpcPayload {
  kind: DwellirGrpcStreamKind;
  receivedAt: string;
  data: Uint8Array;
}

type DwellirUpdateHandler = (update: DwellirGrpcPayload) => Promise<void> | void;

const POSITION_TYPE = "hyperliquid_l1_gateway.v2.Position";
const TIMESTAMP_TYPE = "hyperliquid_l1_gateway.v2.Timestamp";
const BLOCK_TYPE = "hyperliquid_l1_gateway.v2.Block";
const FILLS_TYPE = "hyperliquid_l1_gateway.v2.BlockFills";
const ORDERBOOK_TYPE = "hyperliquid_l1_gateway.v2.OrderBookSnapshot";

export class DwellirHyperliquidGrpcClient {
  private readonly root: protobuf.Root;
  private readonly positionType: protobuf.Type;
  private readonly timestampType: protobuf.Type;
  private readonly blockType: protobuf.Type;
  private readonly fillsType: protobuf.Type;
  private readonly orderbookType: protobuf.Type;

  constructor(private readonly config: DwellirGrpcClientConfig) {
    if (!hasHyperliquidGrpcDescriptor()) {
      throw new Error("DWELLIR_GRPC_PROTO_DESCRIPTOR_MISSING");
    }

    this.root = protobuf.Root.fromJSON(
      hyperliquidGrpcDescriptor as protobuf.INamespace
    );
    this.positionType = this.lookupType(POSITION_TYPE);
    this.timestampType = this.lookupType(TIMESTAMP_TYPE);
    this.blockType = this.lookupType(BLOCK_TYPE);
    this.fillsType = this.lookupType(FILLS_TYPE);
    this.orderbookType = this.lookupType(ORDERBOOK_TYPE);
  }

  descriptorInfo(): JsonRecord {
    return {
      provider: "DWELLIR",
      generatedAt: hyperliquidGrpcGeneratedAt,
      protoFiles: [...hyperliquidGrpcProtoFiles],
      service: this.config.service,
      streams: ["StreamOrderbookSnapshots", "StreamFills", "StreamBlocks"]
    };
  }

  streamOrderbookSnapshots(
    onUpdate: DwellirUpdateHandler,
    signal?: AbortSignal
  ): Promise<void> {
    return this.streamServerMethod(
      "StreamOrderbookSnapshots",
      this.positionMessage(),
      this.orderbookType,
      "ORDERBOOK_SNAPSHOT",
      onUpdate,
      signal
    );
  }

  streamFills(onUpdate: DwellirUpdateHandler, signal?: AbortSignal): Promise<void> {
    return this.streamServerMethod(
      "StreamFills",
      this.positionMessage(),
      this.fillsType,
      "FILLS",
      onUpdate,
      signal
    );
  }

  streamBlocks(onUpdate: DwellirUpdateHandler, signal?: AbortSignal): Promise<void> {
    return this.streamServerMethod(
      "StreamBlocks",
      this.positionMessage(),
      this.blockType,
      "BLOCK",
      onUpdate,
      signal
    );
  }

  async getOrderBookSnapshot(
    timestampMs: number,
    signal?: AbortSignal
  ): Promise<DwellirGrpcPayload> {
    const request = this.timestampType.encode(
      this.timestampType.fromObject({ timestampMs })
    ).finish();
    const response = await fetch(this.methodUrl("GetOrderBookSnapshot"), {
      method: "POST",
      headers: this.headers(),
      body: encodeGrpcFrame(request),
      signal
    });
    assertGrpcOk(response);

    if (!response.body) {
      throw new Error("DWELLIR_GRPC_MISSING_SNAPSHOT_BODY");
    }

    const frame = await readFirstGrpcFrame(response.body);
    const message = this.orderbookType.decode(frame);
    return {
      kind: "ORDERBOOK_SNAPSHOT",
      receivedAt: new Date().toISOString(),
      data: readDataBytes(message)
    };
  }

  private async streamServerMethod(
    method: string,
    requestPayload: Uint8Array,
    responseType: protobuf.Type,
    kind: DwellirGrpcStreamKind,
    onUpdate: DwellirUpdateHandler,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await fetch(this.methodUrl(method), {
      method: "POST",
      headers: this.headers(),
      body: encodeGrpcFrame(requestPayload),
      signal
    });
    assertGrpcOk(response);

    if (!response.body) {
      throw new Error(`DWELLIR_GRPC_${method.toUpperCase()}_MISSING_BODY`);
    }

    const reader = response.body.getReader();
    let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

    while (!signal?.aborted) {
      const read = await reader.read();
      if (read.done) {
        break;
      }

      const next = appendGrpcChunk(buffered, read.value);
      buffered = next.remainder;

      for (const frame of next.frames) {
        if (frame.compressed) {
          throw new Error("DWELLIR_GRPC_COMPRESSED_FRAME_UNSUPPORTED");
        }

        const message = responseType.decode(frame.payload);
        await onUpdate({
          kind,
          receivedAt: new Date().toISOString(),
          data: readDataBytes(message)
        });
      }
    }
  }

  private positionMessage(): Uint8Array {
    const position: Record<string, number> = {};

    if (
      typeof this.config.startTimestampMs === "number" &&
      Number.isFinite(this.config.startTimestampMs) &&
      this.config.startTimestampMs > 0
    ) {
      position.timestampMs = Math.floor(this.config.startTimestampMs);
    } else if (
      typeof this.config.startBlockHeight === "number" &&
      Number.isFinite(this.config.startBlockHeight) &&
      this.config.startBlockHeight > 0
    ) {
      position.blockHeight = Math.floor(this.config.startBlockHeight);
    }

    return this.positionType.encode(this.positionType.fromObject(position)).finish();
  }

  private headers(): Headers {
    const headers = new Headers({
      "content-type": "application/grpc+proto",
      "grpc-accept-encoding": "identity",
      "te": "trailers",
      "user-agent": "sovereign-sigma-ingest/dwellir-grpc"
    });

    if (this.config.apiKey) {
      headers.set("x-api-key", this.config.apiKey);
    }

    return headers;
  }

  private methodUrl(method: string): string {
    const base = this.config.endpoint.endsWith("/")
      ? this.config.endpoint.slice(0, -1)
      : this.config.endpoint;
    return `${base}/${this.config.service}/${method}`;
  }

  private lookupType(typeName: string): protobuf.Type {
    const lookup = this.root.lookup(typeName);
    if (!(lookup instanceof protobuf.Type)) {
      throw new Error(`DWELLIR_GRPC_TYPE_NOT_FOUND:${typeName}`);
    }
    return lookup;
  }
}

async function readFirstGrpcFrame(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  while (true) {
    const read = await reader.read();
    if (read.done) {
      break;
    }

    const next = appendGrpcChunk(buffered, read.value);
    buffered = next.remainder;

    if (next.frames.length > 0) {
      const frame = next.frames[0];
      if (frame.compressed) {
        throw new Error("DWELLIR_GRPC_COMPRESSED_FRAME_UNSUPPORTED");
      }
      return frame.payload;
    }
  }

  throw new Error("DWELLIR_GRPC_EMPTY_RESPONSE");
}

function readDataBytes(message: protobuf.Message<object>): Uint8Array {
  const data = (message as protobuf.Message<object> & { data?: unknown }).data;

  if (data instanceof Uint8Array) {
    return data;
  }

  if (Array.isArray(data)) {
    return new Uint8Array(data);
  }

  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }

  throw new Error("DWELLIR_GRPC_DATA_BYTES_MISSING");
}
