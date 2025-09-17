import { DataSourcePlugin } from '@grafana/data';
import { DataSource } from './datasource';
import { ConfigEditor } from './ConfigEditor';
import { QueryEditor } from './QueryEditor';
import { CoralogixQuery, CoralogixDataSourceOptions } from './types';

export const plugin = new DataSourcePlugin<DataSource, CoralogixQuery, CoralogixDataSourceOptions>(DataSource)
  .setConfigEditor(ConfigEditor as any)
  .setQueryEditor(QueryEditor);
