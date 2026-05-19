import { DataSourcePlugin } from '@grafana/data';
import { DataSource } from './datasource';
import { ConfigEditor } from './ConfigEditor';
import { QueryEditor } from './QueryEditor';
import { CoralogixDataSourceOptions, CoralogixQuery, CoralogixSecureJsonData } from './types';

export const plugin = new DataSourcePlugin<
  DataSource,
  CoralogixQuery,
  CoralogixDataSourceOptions,
  CoralogixSecureJsonData
>(DataSource)
  .setConfigEditor(ConfigEditor)
  .setQueryEditor(QueryEditor);
