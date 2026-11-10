/** Stream sequence is global within one immutable replay, never device sequence. */
export type SourceMode = 'fixture-replay' | 'core-journal-replay';
export type AckState = 'RECEIVED' | 'FORWARDED' | 'APPLIED' | 'READBACK_VERIFIED' | 'RETRY_PENDING';
export type ReceiptStatus = 'DISPATCHED' | 'ACK_RECORDED' | 'APPLIED' | 'MQTT_DISPATCHED' | 'REVIEW' | 'DUPLICATE' | 'IN_FLIGHT' | 'DISPATCHING' | 'SETTLED';

export interface CommandPayload {
  readonly deviceId: string;
  readonly commandId: string;
  readonly desiredState: boolean;
  readonly deadline?: string;
  readonly epoch?: number;
  readonly issuedAt: string;
}

export interface AckPayload {
  readonly deviceId: string;
  readonly commandId: string;
  readonly ackState: AckState;
  readonly timestamp: string;
  readonly acceptedAt?: string;
  readonly appliedAt?: string;
  readonly ackCode?: string;
  readonly readback?: boolean;
  readonly firmwareRevision?: string;
}

export interface TelemetryPayload {
  readonly deviceId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly state: boolean;
  readonly batteryPct: number;
  readonly rssiDbm: number;
  readonly schemaVersion: '1.0.0';
}

export interface CoreMember {
  readonly memberId: string;
  readonly memberCommandId: string;
  readonly deviceId: string;
  readonly gatewayId: string;
  readonly status: 'DISPATCHED' | AckState;
  readonly attempts: number;
  readonly ackTimestamp?: string;
}

/** Fields emitted by CORE are retained, not renamed or augmented. */
export interface CoreReceipt {
  readonly status: ReceiptStatus;
  readonly timestamp: string;
  readonly journaledAt?: string;
  readonly receiptHash?: string;
  readonly contractId?: 'privacy-bubble.raspberrypi-gateway' | 'privacy-bubble.group-dispatch';
  readonly contractVersion?: '1.0.0';
  readonly docRevision?: '2.0.0';
  readonly gatewayId?: string;
  readonly deviceId?: string;
  readonly commandId?: string;
  readonly sequence?: number;
  readonly dedupKey?: string;
  readonly requestId?: string;
  readonly oneM2MResource?: string;
  readonly responseStatus?: number;
  readonly responseBody?: string;
  readonly transport?: 'mqtt' | 'oneM2M-http' | 'oneM2M-mqtt';
  readonly topic?: string;
  readonly error?: string;
  readonly ackState?: AckState;
  readonly payload?: CommandPayload | AckPayload | TelemetryPayload;
  readonly groupId?: string;
  readonly state?: boolean;
  readonly attempts?: number;
  readonly memberCount?: number;
  readonly appliedCount?: number;
  readonly members?: readonly CoreMember[];
}

export interface ApiAcceptance {
  readonly commandId: string;
  readonly groupId: string;
  readonly acceptedAt: string;
  readonly label: 'SIMULATED API acceptance; not a CORE receipt';
}

export interface EventEnvelope {
  readonly schemaVersion: '1.0.0';
  readonly sequence: number;
  readonly resourceUri: string;
  /** Null means the CORE journal does not provide a resource revision. */
  readonly currentRevision: string | null;
  readonly receivedAt: string;
  /** Descriptive only. This is NOT an authorization decision. */
  readonly roleScope: readonly string[];
  readonly simulation: boolean;
  readonly source: SourceMode;
}

export type DashboardEvent = EventEnvelope & (
  | { readonly type: 'command.accepted'; readonly acceptance: ApiAcceptance; readonly receipt: null }
  | { readonly type: 'command.dispatched' | 'command.ack' | 'gateway.telemetry' | 'receipt.review' | 'group.summary'; readonly acceptance: null; readonly receipt: CoreReceipt }
);

export interface ResourceFixture {
  readonly resourceUri: string;
  readonly parentUri: string | null;
  readonly name: string;
  readonly ty: number;
  readonly cnd?: string;
  readonly state?: boolean;
  readonly deviceId?: string;
  readonly gatewayId?: string;
  readonly health: 'healthy' | 'degraded' | 'unknown';
}

export interface AuditFixture {
  readonly id: string;
  readonly receivedAt: string;
  readonly actor: string;
  readonly action: string;
  readonly resourceUri: string;
  readonly outcome: 'allowed' | 'denied' | 'pending';
  readonly commandId?: string;
  readonly simulation: true;
}
