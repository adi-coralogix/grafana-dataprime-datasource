import { DataQuery, DataSourceJsonData } from '@grafana/data';

export interface CoralogixQuery extends DataQuery {
  text: string;
}

export interface CoralogixDataSourceOptions extends DataSourceJsonData {
  region: string;
  apiKey?: string; // non-secret for direct frontend calls
  baseUrl?: string; // e.g. https://ng-api-http.coralogix.com
}

export interface CoralogixSecureJsonData {
  apiKey: string;
}
