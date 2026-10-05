export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Color = "white" | "black";
export type GameStatus = "waiting" | "active" | "finished";

export interface GameRecord {
  id: string;
  revision: number;
  status: GameStatus;
  rulesetId: string;
  rulesVersion: number;
  rulesConfig: JsonObject;
  engineState: JsonObject;
  lifecycle: JsonObject;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRecord {
  id: string;
  tokenHash: string;
  displayName: string;
  expiresAt: number;
  createdAt: number;
}

export interface SeatRecord {
  gameId: string;
  color: Color;
  sessionId: string;
}

export interface InvitationRecord {
  id: string;
  gameId: string;
  color: Color;
  tokenHash: string;
  expiresAt: number;
  consumedBy: string | null;
  consumedAt: number | null;
}

export interface GameEvent {
  gameId: string;
  revision: number;
  type: string;
  payload: JsonObject;
  createdAt: number;
}

export interface CommandReceipt {
  gameId: string;
  sessionId: string;
  commandId: string;
  payloadHash: string;
  acknowledgement: JsonObject;
  createdAt: number;
}

export interface OutboxEvent extends GameEvent {
  id: string;
  leaseToken: string;
  attempts: number;
}
