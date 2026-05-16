export interface GrpcFrame {
  compressed: boolean;
  payload: Uint8Array;
}

const GRPC_HEADER_BYTES = 5;

export function encodeGrpcFrame(payload: Uint8Array, compressed = false): Uint8Array {
  const frame = new Uint8Array(GRPC_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  frame[0] = compressed ? 1 : 0;
  view.setUint32(1, payload.byteLength, false);
  frame.set(payload, GRPC_HEADER_BYTES);
  return frame;
}

export function appendGrpcChunk(
  buffered: Uint8Array,
  chunk: Uint8Array
): { frames: GrpcFrame[]; remainder: Uint8Array } {
  const bytes = concatBytes(buffered, chunk);
  const frames: GrpcFrame[] = [];
  let offset = 0;

  while (bytes.byteLength - offset >= GRPC_HEADER_BYTES) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, GRPC_HEADER_BYTES);
    const length = view.getUint32(1, false);
    const frameEnd = offset + GRPC_HEADER_BYTES + length;

    if (bytes.byteLength < frameEnd) {
      break;
    }

    frames.push({
      compressed: bytes[offset] === 1,
      payload: bytes.slice(offset + GRPC_HEADER_BYTES, frameEnd)
    });
    offset = frameEnd;
  }

  return {
    frames,
    remainder: offset === bytes.byteLength ? new Uint8Array(0) : bytes.slice(offset)
  };
}

export function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) {
    return right;
  }
  if (right.byteLength === 0) {
    return left;
  }

  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

export function grpcStatusFromHeaders(headers: Headers): string | null {
  return headers.get("grpc-status") ?? headers.get("Grpc-Status");
}

export function assertGrpcOk(response: Response): void {
  const status = grpcStatusFromHeaders(response.headers);

  if (!response.ok || (status !== null && status !== "0")) {
    const grpcMessage = response.headers.get("grpc-message") ?? response.statusText;
    throw new Error(`GRPC_REQUEST_FAILED_${response.status}_${status ?? "NO_STATUS"}:${grpcMessage}`);
  }
}
