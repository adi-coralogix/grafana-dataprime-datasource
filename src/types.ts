import { DataQuery, DataSourceJsonData } from '@grafana/data';

export interface CoralogixQuery extends DataQuery {
  text: string;
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
