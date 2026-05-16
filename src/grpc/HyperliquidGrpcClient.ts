import * as protobuf from "protobufjs";
import { appendGrpcChunk, assertGrpcOk, encodeGrpcFrame } from "./GrpcFrame";
import {
  hasHyperliquidGrpcDescriptor,
  hyperliquidGrpcDescriptor,
  hyperliquidGrpcGeneratedAt,
  hyperliquidGrpcProtoFiles
} from "../types/grpc/hyperliquid";
import type { JsonRecord } from "../types";

export interface HyperliquidGrpcClientConfig {
  endpoint: string;
  token: string;
  authHeader: string;
  service: string;
  streamMethod: string;
  pingMethod?: string;
  subscribeType: string;
  updateType: string;
  pingRequestType?: string;
  pingResponseType?: string;
  streamTypes: string[];
  coins: string[];
  heartbeatIntervalMs: number;
}

export interface HyperliquidGrpcUpdate {
  receivedAt: string;
  streamType: string | null;
  decoded: Record<string, unknown>;
  providerData: unknown;
}

type StreamUpdateHandler = (update: HyperliquidGrpcUpdate) => Promise<void> | void;

export class HyperliquidGrpcClient {
  private readonly root: protobuf.Root;
  private readonly subscribeType: protobuf.Type;
  private readonly updateType: protobuf.Type;
  private readonly encoder = new TextEncoder();

  constructor(private readonly config: HyperliquidGrpcClientConfig) {
    if (!hasHyperliquidGrpcDescriptor()) {
      throw new Error(
        "GRPC_PROTO_DEFINITIONS_MISSING: place provider .proto files in proto/hyperliquid and run npm run proto:compile"
      );
    }

    this.root = protobuf.Root.fromJSON(
      hyperliquidGrpcDescriptor as protobuf.INamespace
    );
    this.subscribeType = this.lookupMessage(config.subscribeType);
    this.updateType = this.lookupMessage(config.updateType);
  }

  descriptorInfo(): JsonRecord {
    return {
      generatedAt: hyperliquidGrpcGeneratedAt,
      protoFiles: [...hyperliquidGrpcProtoFiles],
      service: this.config.service,
      streamMethod: this.config.streamMethod,
      subscribeType: this.config.subscribeType,
      updateType: this.config.updateType
    };
  }

  async ping(signal?: AbortSignal): Promise<void> {
    if (!this.config.pingMethod || !this.config.pingRequestType) {
      return;
    }

    const requestType = this.lookupMessage(this.config.pingRequestType);
    const responseType = this.config.pingResponseType
      ? this.lookupMessage(this.config.pingResponseType)
      : null;
    const payload = requestType.encode(
      requestType.fromObject({ timestampMs: Date.now() })
    ).finish();

    const response = await fetch(this.methodUrl(this.config.pingMethod), {
      method: "POST",
      headers: this.headers(),
      body: encodeGrpcFrame(payload),
      signal
    });
    assertGrpcOk(response);

    if (responseType && response.body) {
      const reader = response.body.getReader();
      let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

      while (true) {
        const read = await reader.read();
        if (read.done) {
          break;
        }

        const next = appendGrpcChunk(buffered, read.value);
        buffered = next.remainder;

        for (const frame of next.frames) {
          if (frame.compressed) {
            throw new Error("GRPC_COMPRESSED_FRAME_UNSUPPORTED");
          }
          responseType.decode(frame.payload);
          return;
        }
      }
    }
  }

  async stream(
    onUpdate: StreamUpdateHandler,
    signal?: AbortSignal
  ): Promise<void> {
    const body = new TransformStream<Uint8Array, Uint8Array>();
    const writer = body.writable.getWriter();
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const writeMessage = async (message: Record<string, unknown>): Promise<void> => {
      const payload = this.subscribeType.encode(
        this.subscribeType.fromObject(message)
      ).finish();
      await writer.write(encodeGrpcFrame(payload));
    };

    const writeSubscribeMessages = async (): Promise<void> => {
      for (const streamType of this.config.streamTypes) {
        await writeMessage({
          subscribe: {
            streamType,
            filters: {
              coin: {
                values: this.config.coins
              }
            },
            filterName: `sovereign-sigma-${streamType.toLowerCase()}`
          }
        });
      }
    };

    const closeWriter = async (): Promise<void> => {
      try {
        await writer.close();
      } catch {
        // The network side may already have closed the body; no recovery is needed.
      }
    };

    signal?.addEventListener("abort", () => {
      void closeWriter();
    });

    const requestInit = {
      method: "POST",
      headers: this.headers(),
      body: body.readable,
      signal,
      duplex: "half"
    } as RequestInit & { duplex: "half" };

    const fetchPromise = fetch(this.methodUrl(this.config.streamMethod), requestInit);

    await writeSubscribeMessages();

    heartbeat = setInterval(() => {
      void writeMessage({ ping: { timestampMs: Date.now() } }).catch(() => {
        void closeWriter();
      });
    }, this.config.heartbeatIntervalMs);

    try {
      const response = await fetchPromise;
      assertGrpcOk(response);

      if (!response.body) {
        throw new Error("GRPC_STREAM_MISSING_RESPONSE_BODY");
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
            throw new Error("GRPC_COMPRESSED_FRAME_UNSUPPORTED");
          }

          const decoded = this.updateType.toObject(
            this.updateType.decode(frame.payload),
            { bytes: Array, defaults: false, enums: String, longs: String, oneofs: true }
          ) as Record<string, unknown>;
          const receivedAt = new Date().toISOString();
          await onUpdate({
            receivedAt,
            streamType: extractStreamType(decoded),
            decoded,
            providerData: extractProviderData(decoded)
          });
        }
      }
    } finally {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
      }
      await closeWriter();
    }
  }

  private headers(): Headers {
    const headers = new Headers({
      "content-type": "application/grpc+proto",
      "grpc-accept-encoding": "identity",
      "te": "trailers",
      "user-agent": "sovereign-sigma-ingest/phase-58"
    });
    headers.set(this.config.authHeader, this.config.token);
    return headers;
  }

  private methodUrl(method: string): string {
    const base = this.config.endpoint.endsWith("/")
      ? this.config.endpoint.slice(0, -1)
      : this.config.endpoint;
    return `${base}/${this.config.service}/${method}`;
  }

  private lookupMessage(typeName: string): protobuf.Type {
    const lookup = this.root.lookup(typeName);
    if (!(lookup instanceof protobuf.Type)) {
      throw new Error(`GRPC_TYPE_NOT_FOUND:${typeName}`);
    }
    return lookup;
  }

  // The encoder is kept as an instance field to force bundlers to retain TextEncoder
  // in Workers builds that tree-shake only side-effect-free global references.
  encodeDebugString(value: string): Uint8Array {
    return this.encoder.encode(value);
  }
}

function extractStreamType(decoded: Record<string, unknown>): string | null {
  const candidates = [
    decoded.streamType,
    decoded.type,
    readNested(decoded, ["data", "streamType"]),
    readNested(decoded, ["data", "type"])
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return null;
}

function extractProviderData(decoded: Record<string, unknown>): unknown {
  const direct = decoded.data;

  if (isRecord(direct)) {
    if (typeof direct.data === "string") {
      return parseProviderJson(direct.data);
    }
    return direct;
  }

  if (typeof direct === "string") {
    return parseProviderJson(direct);
  }

  return decoded;
}

function parseProviderJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readNested(value: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = value;

  for (const key of path) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }

  return cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
