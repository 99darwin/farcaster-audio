/**
 * Shared fixtures for the Protocol Auth tests. The mnemonics are the public
 * Hardhat/Foundry and BIP-39 test vectors — they control no real funds or FIDs.
 */

import type { Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type {
  Eip712Payload,
  LoginResponse,
  SignerPrepareResponse,
} from "@/lib/api/types";

export const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
export const OTHER_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
export const TEST_FID = 4242;
export const TEST_BASE_URL = "https://api.test";

export const KEY_GATEWAY_DOMAIN = {
  name: "Farcaster KeyGateway",
  version: "1",
  chainId: 10,
  verifyingContract: "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B",
} as const;

const ADD_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  Add: [
    { name: "owner", type: "address" },
    { name: "keyType", type: "uint32" },
    { name: "key", type: "bytes" },
    { name: "metadataType", type: "uint8" },
    { name: "metadata", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export function addPayload(params: {
  owner: string;
  keyType: number;
  key: Hex;
  nonce: number;
  deadline: number;
}): Eip712Payload {
  return {
    domain: { ...KEY_GATEWAY_DOMAIN },
    types: ADD_TYPES,
    primaryType: "Add",
    message: {
      owner: params.owner,
      keyType: params.keyType,
      key: params.key,
      metadataType: 1,
      metadata: "0x",
      // The backend may send big integers as decimal strings.
      nonce: String(params.nonce),
      deadline: params.deadline,
    },
  };
}

export function buildPrepare(params: {
  authAddress: Hex;
  nowSeconds: number;
  custodyAddress?: string;
}): SignerPrepareResponse {
  const custody =
    params.custodyAddress ?? mnemonicToAccount(TEST_MNEMONIC).address;
  const deadline = params.nowSeconds + 600;
  const signerKey: Hex = `0x${"ab".repeat(32)}`;
  return {
    prepare_id: "prep_123",
    custody_address: custody,
    signer_public_key: signerKey,
    typed_data: {
      signer: addPayload({
        owner: custody,
        keyType: 1,
        key: signerKey,
        nonce: 7,
        deadline,
      }),
      auth_address: addPayload({
        owner: custody,
        keyType: 2,
        // KeyRegistry's keyType 2 key: 12 zero bytes + the 20-byte address.
        key: `0x${"0".repeat(24)}${params.authAddress.slice(2).toLowerCase()}`,
        nonce: 8,
        deadline,
      }),
    },
    protocol_auth: {
      domain: "juke.audio",
      uri: "https://juke.audio",
      nonce: "prepareNonce123",
      expires_at: deadline,
    },
    expires_at: deadline,
  };
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

type Route = (request: RecordedRequest) => { status: number; body?: unknown };

/** A `fetch` stand-in that routes by `METHOD pathname` and records calls. */
export function createFetchMock(routes: Record<string, Route>): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const request = { method, path: url.pathname + url.search, body };
    requests.push(request);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response("{}", { status: 404 });
    const result = route(request);
    return new Response(
      result.body === undefined ? "" : JSON.stringify(result.body),
      { status: result.status },
    );
  }) as typeof fetch;
  return { fetchImpl, requests };
}

export const LOGIN_RESPONSE: LoginResponse = {
  jwt: "jwt-value",
  refresh_token: null,
  expires_at: "2026-10-16T12:00:00Z",
  user: {
    fid: TEST_FID,
    username: "tester",
    display_name: "Tester",
    pfp_url: null,
    custody_address: null,
    is_pro: false,
    is_admin: false,
    signer_status: "approved",
  },
};
