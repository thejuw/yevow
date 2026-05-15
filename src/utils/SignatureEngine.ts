import { encode as msgpackEncode } from "@msgpack/msgpack";
import { getBytes, keccak256, Signature, Wallet } from "ethers";

type SignatureAlgorithm = "HMAC-SHA256" | "ED25519";

const keyCache = new Map<string, CryptoKey>();

export interface HyperliquidSignature {
  r: string;
  s: string;
  v: number;
}

export class SignatureEngine {
  static async sign(input: {
    algorithm: SignatureAlgorithm;
    secret: string;
    payload: string;
  }): Promise<string> {
    if (input.algorithm === "ED25519") {
      const key = await importEd25519Key(input.secret);
      const signature = await crypto.subtle.sign("Ed25519", key, text(input.payload));
      return base64(signature);
    }

    const key = await importHmacKey(input.secret);
    const signature = await crypto.subtle.sign("HMAC", key, text(input.payload));
    return hex(signature);
  }

  static async signHyperliquidL1Action(input: {
    secret: string;
    action: unknown;
    nonce: number;
    vaultAddress?: string | null;
    expiresAfter?: number | null;
    isMainnet?: boolean;
  }): Promise<HyperliquidSignature> {
    const privateKey = normalizePrivateKey(input.secret);
    const wallet = new Wallet(privateKey);
    const connectionId = hyperliquidActionHash(
      input.action,
      input.vaultAddress ?? null,
      input.nonce,
      input.expiresAfter ?? null
    );
    const signed = await wallet.signTypedData(
      {
        name: "Exchange",
        version: "1",
        chainId: 1337,
        verifyingContract: "0x0000000000000000000000000000000000000000"
      },
      {
        Agent: [
          { name: "source", type: "string" },
          { name: "connectionId", type: "bytes32" }
        ]
      },
      {
        source: input.isMainnet === false ? "b" : "a",
        connectionId
      }
    );
    const signature = Signature.from(signed);

    return {
      r: signature.r,
      s: signature.s,
      v: signature.v
    };
  }

  static hyperliquidAddressFromPrivateKey(secret: string): string {
    return new Wallet(normalizePrivateKey(secret)).address.toLowerCase();
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const cacheKey = `hmac:${await fingerprintSecret(secret)}`;
  const cached = keyCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    text(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  keyCache.set(cacheKey, key);
  return key;
}

async function importEd25519Key(rawBase64: string): Promise<CryptoKey> {
  const cacheKey = `ed25519:${await fingerprintSecret(rawBase64)}`;
  const cached = keyCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const binary = Uint8Array.from(atob(rawBase64), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", binary, "Ed25519", false, ["sign"]);
  keyCache.set(cacheKey, key);
  return key;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function fingerprintSecret(secret: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", text(secret)));
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64(buffer: ArrayBuffer): string {
  let raw = "";
  for (const byte of new Uint8Array(buffer)) {
    raw += String.fromCharCode(byte);
  }
  return btoa(raw);
}

function hyperliquidActionHash(
  action: unknown,
  vaultAddress: string | null,
  nonce: number,
  expiresAfter: number | null
): string {
  const actionBytes = msgpackEncode(action);
  const nonceBytes = uint64Bytes(nonce);
  const vaultBytes = vaultAddress
    ? concatBytes(new Uint8Array([1]), addressBytes(vaultAddress))
    : new Uint8Array([0]);
  const expiresBytes =
    expiresAfter === null
      ? new Uint8Array()
      : concatBytes(new Uint8Array([0]), uint64Bytes(expiresAfter));

  return keccak256(concatBytes(actionBytes, nonceBytes, vaultBytes, expiresBytes));
}

function normalizePrivateKey(secret: string): string {
  const trimmed = secret.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return `0x${trimmed}`;
  }

  throw new Error("INVALID_HYPERLIQUID_AGENT_SECRET");
}

function addressBytes(address: string): Uint8Array {
  const normalized = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("INVALID_HYPERLIQUID_ADDRESS");
  }

  return getBytes(normalized);
}

function uint64Bytes(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("INVALID_UINT64_VALUE");
  }

  let remaining = BigInt(value);
  const bytes = new Uint8Array(8);
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}
