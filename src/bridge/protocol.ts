import { Station } from '../voice/stations';

export const BRIDGE_PROTOCOL = 1 as const;

export interface BridgeHello {
  type: 'hello';
  protocol: typeof BRIDGE_PROTOCOL;
  version?: string;
  capabilities: string[];
  stations: Station[];
}

export interface BridgeHeartbeat {
  type: 'heartbeat';
  protocol?: typeof BRIDGE_PROTOCOL;
  capabilities?: string[];
  stations?: Station[];
}

export interface BridgeRequest {
  type: 'request';
  protocol: typeof BRIDGE_PROTOCOL;
  id: string;
  method: string;
  params: unknown;
}

export interface BridgeAck {
  type: 'ack';
  id: string;
}

export interface BridgeResponse {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type BridgeIncoming = BridgeHello | BridgeHeartbeat | BridgeAck | BridgeResponse;

export interface BridgeClientInfo {
  clientId: string;
  connectedAt: number;
  lastSeenAt: number;
  version: string | null;
  capabilities: string[];
  stations: Station[];
}

export interface BridgeStation extends Station {
  clientId: string;
}

