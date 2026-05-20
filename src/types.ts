import type { DataQuery, DataSourceJsonData } from '@grafana/data';

export interface CoralogixQuery extends DataQuery {
  text: string;
  /** traceID injected by Grafana's "View Linked Span" / Trace ID navigation */
  query?: string;
}

export interface CoralogixDataSourceOptions extends DataSourceJsonData {
  region: string;
  baseUrl?: string;
}

export interface CoralogixSecureJsonData {
  apiKey: string;
}

export interface DataPrimeKeyValue {
  key: string;
  value: string;
}

/**
 * Represents a single result row from the DataPrime API.
 * Extends Record to accommodate both log rows and aggregation rows.
 */
export interface DataPrimeResult extends Record<string, unknown> {
  userData?: string | Record<string, unknown>;
  metadata?: DataPrimeKeyValue[];
  labels?: DataPrimeKeyValue[];
  // Aggregation fields
  severity?: string;
  _count?: number;
  count?: number;
}

export interface DataPrimeResultGroup {
  results?: DataPrimeResult[];
}

export interface DataPrimeResponseEnvelope {
  result?: DataPrimeResultGroup;
  response?: { results?: DataPrimeResultGroup };
}

// ─── Span / Trace types (Jaeger-style, as returned by DataPrime) ─────────────

export interface DataPrimeSpanProcess {
  serviceName?: string;
  tags?: Record<string, unknown>;
}

export interface DataPrimeSpanReference {
  traceID?: string;
  spanID?: string;
  refType?: string;
}

export interface DataPrimeSpanLog {
  timestamp: number;
  fields: Array<{ key: string; value: unknown }>;
}

/** Shape of the JSON blob stored in DataPrime span `userData`. */
export interface DataPrimeSpanUserData {
  traceID?: string;
  spanID?: string;
  parentId?: string;
  operationName?: string;
  startTimeMillis?: number;
  startTime?: number;
  duration?: number;
  process?: DataPrimeSpanProcess;
  tags?: Record<string, unknown>;
  references?: DataPrimeSpanReference[];
  logs?: DataPrimeSpanLog[] | null;
}
