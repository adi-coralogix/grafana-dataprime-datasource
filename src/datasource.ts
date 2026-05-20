import { DataSourceApi, FieldType, MutableDataFrame } from '@grafana/data';
import type {
  CoreApp,
  DataFrame,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceInstanceSettings,
  ScopedVars,
} from '@grafana/data';
import { getBackendSrv, getTemplateSrv } from '@grafana/runtime';
import type { CoralogixDataSourceOptions, CoralogixQuery, DataPrimeResponseEnvelope } from './types';
import type { LogFrameConfig } from './utils';
import { collectRowsFromLines, isSpanQuery, looksLikeAggregation, toAggregateFrames, toLogsFrame, toTraceFrame } from './utils';

const DEFAULT_LIMIT = 15000;

export class DataSource extends DataSourceApi<CoralogixQuery, CoralogixDataSourceOptions> {
  private readonly instanceSettings: DataSourceInstanceSettings<CoralogixDataSourceOptions>;

  constructor(instanceSettings: DataSourceInstanceSettings<CoralogixDataSourceOptions>) {
    super(instanceSettings);
    this.instanceSettings = instanceSettings;
  }

  getDefaultQuery(_app: CoreApp): Partial<CoralogixQuery> {
    return { text: 'source logs' };
  }

  applyTemplateVariables(query: CoralogixQuery, scopedVars: ScopedVars): CoralogixQuery {
    return {
      ...query,
      text: getTemplateSrv().replace(query.text, scopedVars),
    };
  }

  async query(req: DataQueryRequest<CoralogixQuery>): Promise<DataQueryResponse> {
    const configError = this.validateConfig();
    if (configError) {
      throw new Error(configError);
    }

    const activeTargets = req.targets.filter((t) => !t.hide && (t.text ?? '').trim());
    if (activeTargets.length === 0) {
      return { data: [] };
    }

    // Fan out all targets in parallel; each carries its own requestId so
    // Grafana automatically cancels stale calls when a new query arrives.
    const frames = await Promise.all(
      activeTargets.map((target) => this.runTarget(target, req))
    );

    return { data: frames.flat() };
  }

  private async runTarget(
    target: CoralogixQuery,
    req: DataQueryRequest<CoralogixQuery>
  ): Promise<DataFrame[]> {
    let userQuery = String(target.text ?? '').trim();

    // When Grafana's "View Linked Span" passes a traceID in target.query,
    // synthesize a DataPrime filter instead of running the bare "source spans".
    // Also widen the time window to ±12 h around now so the trace is always
    // in range regardless of the dashboard's current time picker.
    const isTraceIdNav = Boolean(target.query && /^[0-9a-f]{16,64}$/i.test(target.query.trim()));
    if (isTraceIdNav) {
      userQuery = `source spans | filter $d.traceID == '${target.query!.trim()}'`;
    }

    if (!/\blimit\s+\d+/i.test(userQuery)) {
      userQuery = userQuery ? `${userQuery} | limit ${DEFAULT_LIMIT}` : `source logs | limit ${DEFAULT_LIMIT}`;
    }

    const now = Date.now();
    const startDate = isTraceIdNav
      ? new Date(now - 12 * 60 * 60 * 1000).toISOString()
      : req.range.from.toISOString();
    const endDate = isTraceIdNav
      ? new Date(now).toISOString()
      : req.range.to.toISOString();

    const body = {
      query: userQuery,
      metadata: {
        tier: 'TIER_ARCHIVE',
        syntax: 'QUERY_SYNTAX_DATAPRIME',
        startDate,
        endDate,
        defaultSource: 'logs',
      },
    };

    let text: string;
    try {
      // Authorization is injected by Grafana's server-side proxy (plugin.json routes);
      // the API key never leaves the Grafana backend.
      // requestId lets Grafana cancel the in-flight call when a newer query
      // supersedes this one — avoids stale responses clobbering the panel.
      const raw: unknown = await getBackendSrv().post(
        this.proxyUrl('/v1/dataprime/query'),
        body,
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          requestId: `dataprime-${req.requestId ?? ''}-${target.refId}`,
        }
      );
      text = typeof raw === 'string' ? raw : '';
    } catch (e) {
      if (isRequestCancelled(e)) {
        return [];
      }
      throw new Error(formatQueryError(e));
    }

    const ndLines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'));

    const logCfg: LogFrameConfig = {
      datasourceUid: this.instanceSettings.uid,
      datasourceName: this.instanceSettings.name,
    };

    const ndRows = collectRowsFromLines(ndLines);
    if (ndRows.length > 0) {
      return this.framify(ndRows, target.refId, req.range.to.valueOf(), userQuery, logCfg);
    }

    try {
      const json = JSON.parse(text) as DataPrimeResponseEnvelope;
      const rows = json?.result?.results ?? json?.response?.results?.results ?? [];
      return this.framify(rows, target.refId, req.range.to.valueOf(), userQuery, logCfg);
    } catch {
      const raw = new MutableDataFrame({
        fields: [{ name: '_raw', type: FieldType.string, values: [text.slice(0, 1000)] }],
      });
      raw.refId = target.refId;
      return [raw];
    }
  }

  private framify(
    rows: ReturnType<typeof collectRowsFromLines>,
    refId: string,
    atMs: number,
    query: string,
    logCfg?: LogFrameConfig,
  ): MutableDataFrame[] {
    let frames: MutableDataFrame[];
    const isAgg = looksLikeAggregation(rows) || /\b(groupby|countby|count\s+by|aggregate|timeseries)\b/i.test(query);
    if (isAgg) {
      frames = toAggregateFrames(rows, atMs);
    } else if (isSpanQuery(query)) {
      frames = [toTraceFrame(rows)];
    } else {
      frames = [toLogsFrame(rows, logCfg)];
    }
    frames.forEach((f) => {
      f.refId = refId;
    });
    return frames;
  }

  filterQuery(query: CoralogixQuery): boolean {
    return Boolean(query.text?.trim());
  }

  async testDatasource(): Promise<{ status: string; message: string }> {
    const configError = this.validateConfig();
    if (configError) {
      return { status: 'error', message: configError };
    }

    try {
      await getBackendSrv().post(
        this.proxyUrl('/v1/dataprime/query'),
        {
          query: 'source logs | limit 1',
          metadata: {
            tier: 'TIER_ARCHIVE',
            syntax: 'QUERY_SYNTAX_DATAPRIME',
            startDate: new Date(Date.now() - 60_000).toISOString(),
            endDate: new Date().toISOString(),
            defaultSource: 'logs',
          },
        },
        {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'text',
          requestId: `dataprime-test-${this.instanceSettings.id}`,
        }
      );
      return { status: 'success', message: 'Data source connected successfully.' };
    } catch (e) {
      return { status: 'error', message: formatQueryError(e) };
    }
  }

  private proxyUrl(path: string): string {
    return `/api/datasources/proxy/${this.instanceSettings.id}/cx${path}`;
  }

  private validateConfig(): string | null {
    const { baseUrl } = this.instanceSettings.jsonData;
    if (!baseUrl) {
      return 'Base URL is not configured — open datasource settings and select a region.';
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      return `Invalid Base URL "${baseUrl}": must start with https://.`;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFetchError(e: unknown): e is { status: number; statusText?: string } {
  return (
    typeof e === 'object' &&
    e !== null &&
    'status' in e &&
    typeof (e as Record<string, unknown>)['status'] === 'number'
  );
}

function isRequestCancelled(e: unknown): boolean {
  if (typeof e === 'object' && e !== null && (e as Record<string, unknown>)['cancelled'] === true) {
    return true;
  }
  if (e instanceof Error && /cancel/i.test(e.message)) {
    return true;
  }
  return false;
}

function formatQueryError(e: unknown): string {
  if (isFetchError(e)) {
    switch (e.status) {
      case 401:
        return 'Authentication failed — check your API key in the datasource settings.';
      case 403:
        return 'Permission denied — your API key may not have access to this data.';
      case 429:
        return 'Rate limited — reduce query frequency or narrow the time range.';
      case 504:
        return 'Gateway timeout — try narrowing the time range or adding a limit clause.';
      default:
        return `DataPrime API error ${e.status}${e.statusText ? `: ${e.statusText}` : ''}.`;
    }
  }
  const message = e instanceof Error ? e.message : String(e);
  if (/timeout/i.test(message)) {
    return 'Request timed out — try narrowing the time range or adding a limit clause.';
  }
  return `DataPrime query failed: ${message}`;
}
