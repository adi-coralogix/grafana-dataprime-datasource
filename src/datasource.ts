import { DataSourceInstanceSettings, CoreApp, DataQueryRequest, DataQueryResponse, DataSourceApi, MutableDataFrame, FieldType } from '@grafana/data';
import { getTemplateSrv } from '@grafana/runtime';
import { CoralogixDataSourceOptions, CoralogixQuery } from './types';

export class DataSource extends DataSourceApi<CoralogixQuery, CoralogixDataSourceOptions> {
  constructor(instanceSettings: DataSourceInstanceSettings<CoralogixDataSourceOptions>) {
    super(instanceSettings);
    this.instanceSettings = instanceSettings;
  }

  private readonly instanceSettings: DataSourceInstanceSettings<CoralogixDataSourceOptions>;

  getDefaultQuery(_: CoreApp): Partial<CoralogixQuery> {
    return {
      text: 'source logs',
    };
  }

  applyTemplateVariables(query: CoralogixQuery, scopedVars: any): CoralogixQuery {
    return {
      ...query,
      text: getTemplateSrv().replace(query.text, scopedVars),
    };
  }

  private resolveBaseUrl(): string {
    const cfg = this.instanceSettings.jsonData || {};
    if (cfg.baseUrl && cfg.baseUrl.trim()) {
      return cfg.baseUrl.replace(/\/$/, '');
    }
    const region = (cfg.region || 'eu1').trim();
    return `https://api.${region}.coralogix.com`;
  }

  async query(req: DataQueryRequest<CoralogixQuery>): Promise<DataQueryResponse> {
    const cfg = this.instanceSettings.jsonData || {} as any;
    const baseUrl = this.resolveBaseUrl();
    const apiKey = cfg.apiKey || '';

    const target = req.targets.find((t) => !t.hide && (t.text || '').trim());
    if (!target) {
      return { data: [] };
    }

    // Force DATAPRIME + ARCHIVE and inject default limit when not provided by user
    let userQuery = String(target.text || '').trim();
    if (!/\blimit\s+\d+/i.test(userQuery)) {
      userQuery = userQuery ? `${userQuery} | limit 15000` : 'source logs | limit 15000';
    }

    const body: any = {
      query: userQuery,
      metadata: {
        tier: 'TIER_ARCHIVE',
        syntax: 'QUERY_SYNTAX_DATAPRIME',
        startDate: req.range.from.toISOString(),
        endDate: req.range.to.toISOString(),
        defaultSource: 'logs',
      },
    };

    const url = `${baseUrl}/api/v1/dataprime/query`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      throw new Error(`Network error calling Coralogix: ${err?.message || err}`);
    }

    if (!res.ok) {
      const textErr = await res.text().catch(() => '');
      throw new Error(`Coralogix HTTP ${res.status}: ${textErr.slice(0, 500)}`);
    }

    const text = await res.text();

    // Try NDJSON first
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l.startsWith('{'));
    const ndRows = collectRowsFromLines(lines);
    if (ndRows.length > 0) {
      // Detect aggregation results (e.g., countby $m.severity)
      const isAgg = looksLikeSeverityAggregation(ndRows);
      if (isAgg) {
        const seriesFrames = toSeverityAggregateSeries(ndRows, req.range.to.valueOf());
        seriesFrames.forEach((f) => ((f as any).refId = target.refId));
        return { data: seriesFrames };
      }
      const logsFrame = toLogsFrame(ndRows);
      logsFrame.refId = target.refId;
      return { data: [logsFrame] };
    }

    // Fallback: JSON body
    try {
      const json: any = JSON.parse(text);
      const resultGroups: any[] = json?.result?.results || json?.response?.results?.results || [];
      const rows = Array.isArray(resultGroups) ? resultGroups : [];
      const isAgg = looksLikeSeverityAggregation(rows);
      if (isAgg) {
        const seriesFrames = toSeverityAggregateSeries(rows, req.range.to.valueOf());
        seriesFrames.forEach((f) => ((f as any).refId = target.refId));
        return { data: seriesFrames };
      }
      const logsFrame = toLogsFrame(rows);
      logsFrame.refId = target.refId;
      return { data: [logsFrame] };
    } catch (e) {
      // Last resort: show everything as a single _raw row
      const raw = new MutableDataFrame({
        fields: [{ name: '_raw', type: FieldType.string, values: [text.slice(0, 1000)] }],
      });
      raw.refId = target.refId;
      return { data: [raw] };
    }
  }

  filterQuery(query: CoralogixQuery): boolean {
    return !!query.text?.trim();
  }

  async testDatasource() {
    return { status: 'success', message: 'OK' } as const;
  }
}

function collectRowsFromLines(lines: string[]): any[] {
  const rows: any[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const resultGroups: any[] = obj?.result?.results || obj?.response?.results?.results || [];
      if (Array.isArray(resultGroups)) {
        rows.push(...resultGroups);
      }
    } catch (_) {
      // ignore
    }
  }
  return rows;
}

// Build a Grafana logs frame (time + line)
function toLogsFrame(input: any[]): MutableDataFrame {
  const times: number[] = [];
  const lines: string[] = [];
  const severities: string[] = [];
  const applications: string[] = [];
  const subsystems: string[] = [];
  const messages: string[] = [];
  const bodies: string[] = [];
  for (const r of input) {
    const metaObj = kvArrayToObject(r?.metadata);
    const labelObj = kvArrayToObject(r?.labels);
    const severity = metaObj?.severity || '';
    let tsStr = metaObj?.timestamp || metaObj?.timestampMicros;
    let ts = Date.now();
    if (typeof tsStr === 'string' && /^\d+$/.test(tsStr)) {
      // numeric string in micros
      ts = Math.floor(parseInt(tsStr, 10) / 1000);
    } else if (typeof tsStr === 'number') {
      // assume micros numeric
      ts = Math.floor(tsStr / 1000);
    } else if (typeof tsStr === 'string') {
      // ISO string; if no timezone provided, treat as UTC
      const iso = /Z|[+-]\d{2}:?\d{2}$/.test(tsStr) ? tsStr : `${tsStr.replace(/\s+$/, '')}Z`;
      const parsed = Date.parse(iso);
      if (!isNaN(parsed)) {
        ts = parsed;
      }
    }

    let message = '';
    if (typeof r?.userData === 'string') {
      try {
        const ud = JSON.parse(r.userData);
        message = (ud?.log_obj?.message ?? ud?.message ?? JSON.stringify(ud));
        bodies.push(String(ud?.body ?? ud?.log_obj?.body ?? ''));
      } catch (_) {
        message = r.userData;
        bodies.push('');
      }
    } else {
      message = JSON.stringify(r);
      bodies.push('');
    }

    times.push(ts);
    lines.push(`${severity} ${message}`.trim());
    severities.push(String(severity || ''));
    applications.push(String(labelObj?.applicationname || ''));
    subsystems.push(String(labelObj?.subsystemname || ''));
    messages.push(String(message || ''));
  }

  const frame = new MutableDataFrame({
    fields: [
      { name: 'time', type: FieldType.time, values: times },
      { name: 'line', type: FieldType.string, values: lines },
      { name: 'severity', type: FieldType.string, values: severities },
      { name: 'applicationname', type: FieldType.string, values: applications },
      { name: 'subsystemname', type: FieldType.string, values: subsystems },
      { name: 'message', type: FieldType.string, values: messages },
      { name: 'body', type: FieldType.string, values: bodies },
    ],
  });
  (frame as any).meta = { preferredVisualisationType: 'logs' };
  return frame;
}

// removed per lint; we rely on aggregation-aware series only

function kvArrayToObject(arr: any): any {
  const obj: any = {};
  if (Array.isArray(arr)) {
    for (const kv of arr) {
      const k = kv?.key;
      const v = kv?.value;
      if (k) {
        obj[k] = v;
      }
    }
  }
  return obj;
}

// Detect results like: { "_count": N, "severity": "Info" }
function looksLikeSeverityAggregation(rows: any[]): boolean {
  return rows.some((r) => {
    const keys = Object.keys(r || {});
    return (keys.includes('_count') || keys.includes('count')) && keys.includes('severity') && !Array.isArray(r?.metadata);
  });
}

// Build series for severity aggregation (single point per severity at range end)
function toSeverityAggregateSeries(rows: any[], atMs: number): MutableDataFrame[] {
  const bySev: Record<string, number> = {};
  for (const r of rows) {
    const sev = String((r?.severity ?? '') || '').trim() || 'unknown';
    const count = Number(r?._count ?? r?.count ?? 0) || 0;
    bySev[sev] = (bySev[sev] || 0) + count;
  }
  const frames: MutableDataFrame[] = [];
  for (const [sev, count] of Object.entries(bySev)) {
    const frame = new MutableDataFrame({
      name: `logs ${sev}`,
      fields: [
        { name: 'time', type: FieldType.time, values: [atMs] },
        { name: 'value', type: FieldType.number, values: [count], labels: { severity: sev } as any },
      ],
    });
    (frame as any).meta = { preferredVisualisationType: 'graph' };
    frames.push(frame);
  }
  return frames;
}
