import { appendGrpcChunk, assertGrpcOk, encodeGrpcFrame } from "./GrpcFrame";
import {
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

export class DwellirHyperliquidGrpcClient {
  constructor(private readonly config: DwellirGrpcClientConfig) {}

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
      "ORDERBOOK_SNAPSHOT",
      onUpdate,
      signal
    );
  }

  streamFills(onUpdate: DwellirUpdateHandler, signal?: AbortSignal): Promise<void> {
    return this.streamServerMethod(
      "StreamFills",
      this.positionMessage(),
      "FILLS",
      onUpdate,
      signal
    );
  }

  streamBlocks(onUpdate: DwellirUpdateHandler, signal?: AbortSignal): Promise<void> {
    return this.streamServerMethod(
      "StreamBlocks",
      this.positionMessage(),
      "BLOCK",
      onUpdate,
      signal
    );
  }

  async getOrderBookSnapshot(
    timestampMs: number,
    signal?: AbortSignal
  ): Promise<DwellirGrpcPayload> {
    const request = encodeInt64Message(1, Math.floor(timestampMs));
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
    return {
      kind: "ORDERBOOK_SNAPSHOT",
      receivedAt: new Date().toISOString(),
      data: readDataField(frame)
    };
  }

  private async streamServerMethod(
    method: string,
    requestPayload: Uint8Array,
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

        await onUpdate({
          kind,
          receivedAt: new Date().toISOString(),
          data: readDataField(frame.payload)
        });
      }
    }
  }

  private positionMessage(): Uint8Array {
    if (
      typeof this.config.startTimestampMs === "number" &&
      Number.isFinite(this.config.startTimestampMs) &&
      this.config.startTimestampMs > 0
    ) {
      return encodeInt64Message(1, Math.floor(this.config.startTimestampMs));
    }

    if (
      typeof this.config.startBlockHeight === "number" &&
      Number.isFinite(this.config.startBlockHeight) &&
      this.config.startBlockHeight > 0
    ) {
      return encodeInt64Message(2, Math.floor(this.config.startBlockHeight));
    }

    return new Uint8Array(0);
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

function encodeInt64Message(fieldNumber: number, value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    return new Uint8Array(0);
  }

  return concatWireParts([
    encodeVarint((fieldNumber << 3) | 0),
    encodeVarint(value)
  ]);
}

function readDataField(message: Uint8Array): Uint8Array {
  let offset = 0;

  while (offset < message.byteLength) {
    const tag = readVarint(message, offset);
    offset = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);

    if (fieldNumber === 1 && wireType === 2) {
      const length = readVarint(message, offset);
      offset = length.nextOffset;
      const end = offset + Number(length.value);
      if (end > message.byteLength) {
        throw new Error("DWELLIR_GRPC_DATA_BYTES_TRUNCATED");
      }
      return message.slice(offset, end);
    }

    offset = skipField(message, offset, wireType);
  }

  throw new Error("DWELLIR_GRPC_DATA_BYTES_MISSING");
}

function skipField(message: Uint8Array, offset: number, wireType: number): number {
  switch (wireType) {
    case 0:
      return readVarint(message, offset).nextOffset;
    case 1:
      return offset + 8;
    case 2: {
      const length = readVarint(message, offset);
      return length.nextOffset + Number(length.value);
    }
    case 5:
      return offset + 4;
    default:
      throw new Error(`DWELLIR_GRPC_UNSUPPORTED_WIRE_TYPE_${wireType}`);
  }
}

function readVarint(
  bytes: Uint8Array,
  offset: number
): { value: bigint; nextOffset: number } {
  let value = 0n;
  let shift = 0n;

  for (let index = offset; index < bytes.byteLength; index += 1) {
    const byte = bytes[index];
    value |= BigInt(byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return { value, nextOffset: index + 1 };
    }

    shift += 7n;
    if (shift > 63n) {
      throw new Error("DWELLIR_GRPC_VARINT_TOO_LONG");
    }
  }

  throw new Error("DWELLIR_GRPC_TRUNCATED_VARINT");
}

function encodeVarint(value: number): Uint8Array {
  let remaining = BigInt(value);
  const bytes: number[] = [];

  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0n);

  return new Uint8Array(bytes);
}

function concatWireParts(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }

  return output;
}
