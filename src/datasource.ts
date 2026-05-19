import {
  CoreApp,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceApi,
  DataSourceInstanceSettings,
  FieldType,
  MutableDataFrame,
  ScopedVars,
} from '@grafana/data';
import { getBackendSrv, getTemplateSrv } from '@grafana/runtime';
import { CoralogixDataSourceOptions, CoralogixQuery, DataPrimeResponseEnvelope } from './types';
import {
  collectRowsFromLines,
  looksLikeSeverityAggregation,
  toLogsFrame,
  toSeverityAggregateSeries,
} from './utils';

export class DataSource extends DataSourceApi<CoralogixQuery, CoralogixDataSourceOptions> {
  private readonly instanceSettings: DataSourceInstanceSettings<CoralogixDataSourceOptions>;

  constructor(instanceSettings: DataSourceInstanceSettings<CoralogixDataSourceOptions>) {
    super(instanceSettings);
    this.instanceSettings = instanceSettings;
  }

  getDefaultQuery(_: CoreApp): Partial<CoralogixQuery> {
    return { text: 'source logs' };
  }

  applyTemplateVariables(query: CoralogixQuery, scopedVars: ScopedVars): CoralogixQuery {
    return {
      ...query,
      text: getTemplateSrv().replace(query.text, scopedVars),
    };
  }

  async query(req: DataQueryRequest<CoralogixQuery>): Promise<DataQueryResponse> {
    const target = req.targets.find((t) => !t.hide && (t.text ?? '').trim());
    if (!target) {
      return { data: [] };
    }

    let userQuery = String(target.text ?? '').trim();
    if (!/\blimit\s+\d+/i.test(userQuery)) {
      userQuery = userQuery ? `${userQuery} | limit 15000` : 'source logs | limit 15000';
    }

    const body = {
      query: userQuery,
      metadata: {
        tier: 'TIER_ARCHIVE',
        syntax: 'QUERY_SYNTAX_DATAPRIME',
        startDate: req.range.from.toISOString(),
        endDate: req.range.to.toISOString(),
        defaultSource: 'logs',
      },
    };

    // Authorization is injected by Grafana's proxy via the plugin.json route —
    // the API key never leaves the Grafana server.
    const proxyPath = `/api/datasources/proxy/${this.instanceSettings.id}/cx/v1/dataprime/query`;
    const rawResponse: unknown = await getBackendSrv().post(proxyPath, body, {
      headers: { 'Content-Type': 'application/json' },
      responseType: 'text',
    });
    const text = typeof rawResponse === 'string' ? rawResponse : '';

    const ndLines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'));

    const ndRows = collectRowsFromLines(ndLines);
    if (ndRows.length > 0) {
      return this.buildResponse(ndRows, target.refId, req.range.to.valueOf());
    }

    try {
      const json = JSON.parse(text) as DataPrimeResponseEnvelope;
      const rows = json?.result?.results ?? json?.response?.results?.results ?? [];
      return this.buildResponse(rows, target.refId, req.range.to.valueOf());
    } catch {
      const raw = new MutableDataFrame({
        fields: [{ name: '_raw', type: FieldType.string, values: [text.slice(0, 1000)] }],
      });
      raw.refId = target.refId;
      return { data: [raw] };
    }
  }

  private buildResponse(
    rows: ReturnType<typeof collectRowsFromLines>,
    refId: string,
    atMs: number
  ): DataQueryResponse {
    if (looksLikeSeverityAggregation(rows)) {
      const frames = toSeverityAggregateSeries(rows, atMs);
      frames.forEach((f) => {
        f.refId = refId;
      });
      return { data: frames };
    }
    const frame = toLogsFrame(rows);
    frame.refId = refId;
    return { data: [frame] };
  }

  filterQuery(query: CoralogixQuery): boolean {
    return Boolean(query.text?.trim());
  }

  async testDatasource() {
    return { status: 'success', message: 'OK' } as const;
  }
}
