import { MutableDataFrame, FieldType } from '@grafana/data';
import { DataPrimeKeyValue, DataPrimeResult, DataPrimeResponseEnvelope } from './types';

export function kvArrayToObject(arr: DataPrimeKeyValue[] | undefined): Record<string, string> {
  const obj: Record<string, string> = {};
  if (!Array.isArray(arr)) {
    return obj;
  }
  for (const kv of arr) {
    if (kv?.key) {
      obj[kv.key] = kv.value ?? '';
    }
  }
  return obj;
}

/**
 * Parse a timestamp value (micros numeric string, micros number, or ISO string) to milliseconds.
 * Returns Date.now() as fallback when the value is absent or unparseable.
 */
export function parseTimestampToMs(tsStr: string | number | undefined): number {
  if (tsStr === undefined || tsStr === null) {
    return Date.now();
  }
  // Numeric string — DataPrime returns microseconds
  if (typeof tsStr === 'string' && /^\d+$/.test(tsStr)) {
    return Math.floor(parseInt(tsStr, 10) / 1000);
  }
  // Numeric value — assume microseconds
  if (typeof tsStr === 'number') {
    return Math.floor(tsStr / 1000);
  }
  // ISO string — append Z if no timezone marker so Date.parse treats it as UTC
  if (typeof tsStr === 'string') {
    const iso = /Z|[+-]\d{2}:?\d{2}$/.test(tsStr) ? tsStr : `${tsStr.replace(/\s+$/, '')}Z`;
    const parsed = Date.parse(iso);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

export function collectRowsFromLines(lines: string[]): DataPrimeResult[] {
  const rows: DataPrimeResult[] = [];
  for (const line of lines) {
    let obj: DataPrimeResponseEnvelope;
    try {
      obj = JSON.parse(line) as DataPrimeResponseEnvelope;
    } catch {
      continue;
    }
    const resultGroups = obj?.result?.results ?? obj?.response?.results?.results ?? [];
    if (Array.isArray(resultGroups)) {
      rows.push(...resultGroups);
    }
  }
  return rows;
}

const COUNT_KEYS = new Set(['_count', 'count']);

/**
 * Returns true when the rows look like aggregation output — i.e. they carry a
 * count field (_count or count) but are NOT log rows (log rows have a metadata
 * array with per-row key-value pairs).
 */
export function looksLikeAggregation(rows: DataPrimeResult[]): boolean {
  return rows.some((r) => {
    const keys = Object.keys(r);
    return (
      (keys.includes('_count') || keys.includes('count')) &&
      !Array.isArray(r.metadata)
    );
  });
}

export function toLogsFrame(input: DataPrimeResult[]): MutableDataFrame {
  const times: number[] = [];
  const lines: string[] = [];
  const severities: string[] = [];
  const applications: string[] = [];
  const subsystems: string[] = [];
  const messages: string[] = [];
  const bodies: string[] = [];

  for (const r of input) {
    const metaObj = kvArrayToObject(r.metadata);
    const labelObj = kvArrayToObject(r.labels);
    const ts = parseTimestampToMs(metaObj['timestamp'] ?? metaObj['timestampMicros']);

    let message = '';
    let userObj: Record<string, unknown> = {};

    if (typeof r.userData === 'string') {
      try {
        const ud = JSON.parse(r.userData) as Record<string, unknown>;
        const logObj = ud['log_obj'] as Record<string, unknown> | undefined;
        message = String(logObj?.['message'] ?? ud['message'] ?? JSON.stringify(ud));
        bodies.push(String(logObj?.['body'] ?? ud['body'] ?? ''));
        userObj = ud;
      } catch {
        message = r.userData;
        bodies.push('');
        userObj = { raw: r.userData };
      }
    } else if (r.userData && typeof r.userData === 'object') {
      message = JSON.stringify(r.userData);
      bodies.push('');
      userObj = r.userData as Record<string, unknown>;
    } else {
      message = JSON.stringify(r);
      bodies.push('');
    }

    times.push(ts);
    lines.push(JSON.stringify({ m: metaObj, l: labelObj, d: userObj }));
    severities.push(metaObj['severity'] ?? '');
    applications.push(labelObj['applicationname'] ?? '');
    subsystems.push(labelObj['subsystemname'] ?? '');
    messages.push(message);
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
  frame.meta = { preferredVisualisationType: 'logs' };
  return frame;
}

/**
 * Convert aggregation rows into Grafana graph series.
 * Groups by every non-count field so this works for any DataPrime `countby`
 * expression — severity, applicationname, subsystemname, or multi-dimensional.
 */
export function toAggregateFrames(rows: DataPrimeResult[], atMs: number): MutableDataFrame[] {
  type Group = { labels: Record<string, string>; count: number };
  const groups = new Map<string, Group>();

  for (const r of rows) {
    const labels: Record<string, string> = {};
    for (const [key, val] of Object.entries(r)) {
      if (!COUNT_KEYS.has(key)) {
        labels[key] = String(val ?? '');
      }
    }
    // Stable key: sort fields so insertion order doesn't matter
    const groupKey = Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`)
      .join('\x00');

    const count = Number(r._count ?? r.count ?? 0) || 0;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.count += count;
    } else {
      groups.set(groupKey, { labels, count });
    }
  }

  return Array.from(groups.values()).map(({ labels, count }) => {
    const name =
      Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ') || 'aggregation';

    const frame = new MutableDataFrame({
      name,
      fields: [
        { name: 'time', type: FieldType.time, values: [atMs] },
        { name: 'value', type: FieldType.number, values: [count], labels },
      ],
    });
    frame.meta = { preferredVisualisationType: 'graph' };
    return frame;
  });
}
