import { MutableDataFrame, FieldType } from '@grafana/data';
import type { DataPrimeKeyValue, DataPrimeResult, DataPrimeResponseEnvelope, DataPrimeSpanUserData } from './types';

// ─── Span / Trace support ───────────────────────────────────────────────────

/** Returns true when the query targets the spans data source. */
export function isSpanQuery(query: string): boolean {
  return /\bsource\s+spans\b/i.test(query);
}

/**
 * Convert a nanosecond timestamp or duration to milliseconds without
 * floating-point precision loss.  JavaScript numbers lose integer precision
 * beyond 53 bits; a typical 19-digit epoch-ns value (e.g. 1700000000000000000)
 * exceeds that, so we use string-slicing (÷ 1_000_000 = drop last 6 digits).
 */
export function nanosToMs(ns: string | number | undefined): number {
  if (ns === undefined || ns === null) return 0;
  const s = String(ns);
  if (!/^\d+$/.test(s)) return 0;
  return s.length <= 6 ? 0 : parseInt(s.slice(0, s.length - 6), 10);
}

type TraceKV = { key: string; value: unknown };

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

export interface LogFrameConfig {
  datasourceUid?: string;
  datasourceName?: string;
}

// Unwrap a value that might be a nested JSON string with a 'message' key.
function unwrapJsonMessage(val: unknown): string {
  if (!val || typeof val !== 'string') {
    return '';
  }
  if (!val.trimStart().startsWith('{')) {
    return val; // plain string — return as-is
  }
  try {
    const parsed = JSON.parse(val) as Record<string, unknown>;
    return String(parsed['message'] ?? parsed['msg'] ?? parsed['body'] ?? '');
  } catch {
    return '';
  }
}

// Build a short, always-readable summary for logs that carry no message field.
// Only uses well-known structured fields so we never accidentally surface
// timestamps, category names, or other noise as the log line.
function buildFallbackLine(ud: Record<string, unknown>): string {
  const level = ud['levelname'] ?? ud['level'];
  const name = ud['name'];
  const file = ud['filename'];
  const lineno = ud['lineno'];

  // Need at least name or file to produce something useful; bare [level] alone
  // is too noisy (every log would show [debug]/[info] with no context).
  if (!name && !file) {
    return '';
  }

  const parts: string[] = [];
  if (level) {
    parts.push(`[${level}]`);
  }
  if (name) {
    parts.push(String(name));
  }
  if (file) {
    parts.push(`@ ${file}${lineno !== undefined ? `:${lineno}` : ''}`);
  }
  return parts.join(' ');
}

function extractMessage(ud: Record<string, unknown>): string {
  // 1. Logstash/Filebeat: d.json.message contains the clean parsed message
  const json = ud['json'] as Record<string, unknown> | undefined;
  if (json?.['message']) {
    return String(json['message']);
  }

  // 2. d.log_obj.message (existing Coralogix pattern)
  const logObj = ud['log_obj'] as Record<string, unknown> | undefined;
  if (logObj?.['message']) {
    return String(logObj['message']);
  }

  // 3. OTel body field (OpenTelemetry standard log record body)
  if (ud['body'] && typeof ud['body'] === 'string') {
    return ud['body'];
  }

  // 4. d.message — plain string or a JSON blob wrapping the real message
  const unwrapped = unwrapJsonMessage(ud['message']);
  if (unwrapped) {
    return unwrapped;
  }

  // 5. d.msg (Python logging shorthand)
  if (ud['msg'] && typeof ud['msg'] === 'string') {
    return ud['msg'];
  }

  return '';
}

function extractTraceContext(ud: Record<string, unknown>): { traceId: string | null; spanId: string | null } {
  const json = ud['json'] as Record<string, unknown> | undefined;
  const rawTrace = String(
    ud['trace_id'] ?? ud['traceId'] ?? ud['trace.id'] ??
    json?.['trace_id'] ?? json?.['traceId'] ?? ''
  ).trim();
  const rawSpan = String(
    ud['span_id'] ?? ud['spanId'] ?? ud['span.id'] ??
    json?.['span_id'] ?? json?.['spanId'] ?? ''
  ).trim();
  return {
    traceId: /^[0-9a-f]{16,64}$/i.test(rawTrace) ? rawTrace : null,
    spanId: /^[0-9a-f]{8,24}$/i.test(rawSpan) ? rawSpan : null,
  };
}

function extractPod(ud: Record<string, unknown>): string {
  // Logstash/Filebeat: d.kubernetes.pod.name
  const k8s = ud['kubernetes'] as Record<string, unknown> | undefined;
  const pod = k8s?.['pod'] as Record<string, unknown> | undefined;
  if (pod?.['name']) {
    return String(pod['name']);
  }
  // OTel resource attributes: d.resource.attributes.k8s_pod_name
  const resource = ud['resource'] as Record<string, unknown> | undefined;
  const attrs = resource?.['attributes'] as Record<string, unknown> | undefined;
  if (attrs?.['k8s_pod_name']) {
    return String(attrs['k8s_pod_name']);
  }
  return '';
}

export function toLogsFrame(input: DataPrimeResult[], cfg?: LogFrameConfig): MutableDataFrame {
  const times: number[] = [];
  const lines: string[] = [];
  const severities: string[] = [];
  const applications: string[] = [];
  const subsystems: string[] = [];
  const bodies: string[] = [];
  const traceIds: Array<string | null> = [];
  const spanIds: Array<string | null> = [];
  const pods: string[] = [];

  // Keep raw objects so we can flatten keys after the full result set is known
  const allUserObjs: Record<string, unknown>[] = [];

  for (const r of input) {
    const metaObj = kvArrayToObject(r.metadata);
    const labelObj = kvArrayToObject(r.labels);
    const ts = parseTimestampToMs(metaObj['timestamp'] ?? metaObj['timestampMicros']);

    let userObj: Record<string, unknown> = {};
    let message = '';

    if (typeof r.userData === 'string') {
      try {
        userObj = JSON.parse(r.userData) as Record<string, unknown>;
        const logObj = userObj['log_obj'] as Record<string, unknown> | undefined;
        message = extractMessage(userObj) || String(logObj?.['message'] ?? '');
        bodies.push(String(logObj?.['body'] ?? userObj['body'] ?? ''));
      } catch {
        message = r.userData;
        bodies.push('');
        userObj = { raw: r.userData };
      }
    } else if (r.userData && typeof r.userData === 'object') {
      userObj = r.userData as Record<string, unknown>;
      message = extractMessage(userObj);
      bodies.push('');
    } else {
      message = JSON.stringify(r);
      bodies.push('');
    }

    const { traceId, spanId } = extractTraceContext(userObj);

    times.push(ts);
    lines.push(message || buildFallbackLine(userObj) || labelObj['subsystemname'] || labelObj['applicationname'] || '(no message)');
    severities.push(metaObj['severity'] ?? '');
    applications.push(labelObj['applicationname'] ?? '');
    subsystems.push(labelObj['subsystemname'] ?? '');
    bodies[bodies.length - 1] = bodies[bodies.length - 1] ?? '';
    traceIds.push(traceId);
    spanIds.push(spanId);
    pods.push(extractPod(userObj));
    allUserObjs.push(userObj);
  }

  // Discover every top-level key in the payload across all rows, sorted by
  // how frequently they appear (most common first) so the important fields
  // bubble to the top of the log details panel.
  const keyFreq = new Map<string, number>();
  for (const obj of allUserObjs) {
    for (const key of Object.keys(obj)) {
      keyFreq.set(key, (keyFreq.get(key) ?? 0) + 1);
    }
  }
  const dKeys = Array.from(keyFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);

  // Build value arrays — one entry per row, null when the key is absent
  const dKeyValues = new Map<string, Array<string | null>>();
  for (const key of dKeys) {
    dKeyValues.set(
      key,
      allUserObjs.map((obj) => {
        const val = obj[key];
        if (val === undefined || val === null) {
          return null;
        }
        return typeof val === 'object' ? JSON.stringify(val) : String(val);
      })
    );
  }

  // Build optional trace DataLink so clicking a traceId opens the trace panel
  const traceIdConfig =
    cfg?.datasourceUid
      ? {
          links: [
            {
              title: 'Open Trace',
              url: '',
              internal: {
                datasourceUid: cfg.datasourceUid,
                datasourceName: cfg.datasourceName ?? '',
                query: {
                  refId: 'A',
                  text: 'source spans',
                  query: '${__value.raw}',
                },
              },
            },
          ],
        }
      : {};

  const spanIdConfig =
    cfg?.datasourceUid
      ? {
          links: [
            {
              title: 'Open Span',
              url: '',
              internal: {
                datasourceUid: cfg.datasourceUid,
                datasourceName: cfg.datasourceName ?? '',
                query: {
                  refId: 'A',
                  text: 'source spans',
                  query: '${__data.fields.traceId}',
                },
                panelsState: {
                  trace: {
                    spanId: '${__value.raw}',
                  },
                },
              },
            },
          ],
        }
      : {};

  const frame = new MutableDataFrame({
    fields: [
      { name: 'time', type: FieldType.time, values: times },
      { name: 'line', type: FieldType.string, values: lines },
      { name: 'severity', type: FieldType.string, values: severities },
      { name: 'applicationname', type: FieldType.string, values: applications },
      { name: 'subsystemname', type: FieldType.string, values: subsystems },
      { name: 'body', type: FieldType.string, values: bodies },
      { name: 'traceId', type: FieldType.string, values: traceIds, config: traceIdConfig },
      { name: 'spanId', type: FieldType.string, values: spanIds, config: spanIdConfig },
      { name: 'pod', type: FieldType.string, values: pods },
    ],
  });

  // Append one field per discovered _d key
  for (const key of dKeys) {
    frame.addField({ name: `d.${key}`, type: FieldType.string, values: dKeyValues.get(key)! });
  }

  frame.meta = { preferredVisualisationType: 'logs' };
  return frame;
}

// DataPrime roundTime() and $m.timestamp return nanosecond epochs (~1.7e18).
// Millisecond epochs are ~1.7e12; anything above this threshold is treated as nanoseconds.
const NS_EPOCH_THRESHOLD = 1e15;

/**
 * Convert aggregation rows into time series or table frames.
 *
 * If any numeric column contains nanosecond epoch values, the result is a set
 * of time series frames (one per unique combination of dimension values) suitable
 * for Grafana's Time series panel.  Otherwise falls back to a flat table.
 *
 * Handles both log aggregations (fields at top level) and span/log aggregations
 * where the actual data is nested inside a userData JSON string.
 */
export function toAggregateFrames(rows: DataPrimeResult[], _atMs: number): MutableDataFrame[] {
  if (rows.length === 0) return [];

  // toAggregateFrames is only called for aggregation queries. The actual result
  // fields may be nested inside userData (both log and span aggregations do this).
  // userData arrives as either a JSON string or an already-parsed object; try both.
  // Fall back to the raw row for countby results that are already flat.
  const flat: Record<string, unknown>[] = rows.map((r) => {
    if (typeof r.userData === 'string' && r.userData.trimStart().startsWith('{')) {
      try { return JSON.parse(r.userData) as Record<string, unknown>; } catch {}
    }
    if (r.userData && typeof r.userData === 'object' && !Array.isArray(r.userData)) {
      return r.userData as Record<string, unknown>;
    }
    return r as Record<string, unknown>;
  });

  // Categorise every column as: time (nanosecond epoch), numeric (metric), or dimension (string).
  const allKeys = Array.from(new Set(flat.flatMap((r) => Object.keys(r))));
  let timeKey: string | undefined;
  const valueKeys: string[] = [];
  const dimKeys: string[] = [];

  for (const key of allKeys) {
    const sample = flat.find((r) => r[key] !== undefined && r[key] !== null)?.[key];
    if (sample === undefined || sample === null) {
      dimKeys.push(key);
      continue;
    }
    const num = Number(sample);
    if (!isNaN(num) && isFinite(num)) {
      if (num > NS_EPOCH_THRESHOLD) {
        timeKey = key; // nanosecond timestamp column
      } else {
        valueKeys.push(key);
      }
    } else {
      dimKeys.push(key);
    }
  }

  // ── Time series mode ───────────────────────────────────────────────────────
  if (timeKey) {
    type SeriesData = { labels: Record<string, string>; times: number[]; vals: Record<string, number[]> };
    const groups = new Map<string, SeriesData>();

    for (const row of flat) {
      const labels: Record<string, string> = {};
      for (const k of dimKeys) {
        labels[k] = String(row[k] ?? '');
      }
      const groupKey = dimKeys.map((k) => `${k}=${labels[k]}`).join('\x00');

      if (!groups.has(groupKey)) {
        const vals: Record<string, number[]> = {};
        for (const vk of valueKeys) {
          vals[vk] = [];
        }
        groups.set(groupKey, { labels, times: [], vals });
      }
      const g = groups.get(groupKey)!;
      g.times.push(Math.floor(Number(row[timeKey!]) / 1_000_000)); // ns → ms
      for (const vk of valueKeys) {
        g.vals[vk].push(Number(row[vk] ?? 0));
      }
    }

    const frames: MutableDataFrame[] = [];
    for (const { labels, times, vals } of groups.values()) {
      for (const vk of valueKeys) {
        const frame = new MutableDataFrame({
          fields: [
            { name: 'time', type: FieldType.time, values: times },
            { name: vk, type: FieldType.number, values: vals[vk], labels },
          ],
        });
        frame.meta = { preferredVisualisationType: 'graph' };
        frames.push(frame);
      }
    }
    return frames;
  }

  // ── Table mode (no time column) ────────────────────────────────────────────
  // For a single-dimension aggregation (e.g. countby $l.applicationname) pivot
  // to wide format so pie/bar/stat panels get one series per category.
  // Grafana long format (many rows, 2 cols) collapses to a single pie slice.
  if (dimKeys.length === 1 && valueKeys.length === 1) {
    const dimKey = dimKeys[0];
    const valKey = valueKeys[0];
    const wideFrame = new MutableDataFrame();
    for (const row of flat) {
      const label = String(row[dimKey] ?? '');
      wideFrame.addField({ name: label, type: FieldType.number, values: [Number(row[valKey] ?? 0)] });
    }
    wideFrame.meta = { preferredVisualisationType: 'table' };
    return [wideFrame];
  }

  // Multi-dimension or multi-value: keep long format table
  const frame = new MutableDataFrame();
  for (const key of dimKeys) {
    frame.addField({
      name: key,
      type: FieldType.string,
      values: flat.map((r) => String(r[key] ?? '')),
    });
  }
  for (const key of valueKeys) {
    frame.addField({
      name: key,
      type: FieldType.number,
      values: flat.map((r) => Number(r[key] ?? 0)),
    });
  }
  frame.meta = { preferredVisualisationType: 'table' };
  return [frame];
}

/**
 * Convert DataPrime span rows into a single Grafana native trace DataFrame.
 *
 * DataPrime returns spans in Jaeger format where all span fields live inside
 * the `userData` JSON blob.  Labels carry Coralogix routing metadata
 * (applicationName, serviceName, subsystemName) using camelCase keys.
 *
 * Field contract matches Grafana's Jaeger/Tempo trace panel:
 *   - `tags`, `serviceTags`, `logs`, `references` → FieldType.other with raw JS arrays
 *   - `startTime` in milliseconds (userData.startTimeMillis)
 *   - `duration` in milliseconds (userData.duration is microseconds → ÷ 1000)
 *   - `parentSpanID` is '' (empty string) for root spans
 */
export function toTraceFrame(rows: DataPrimeResult[]): MutableDataFrame {
  const traceIDs: string[] = [];
  const spanIDs: string[] = [];
  const parentSpanIDs: string[] = [];
  const operationNames: string[] = [];
  const serviceNames: string[] = [];
  const serviceNamespaces: string[] = [];
  const kinds: string[] = [];
  const statusCodes: number[] = [];
  const statusMessages: string[] = [];
  const serviceTagsCol: TraceKV[][] = [];
  const startTimes: number[] = [];
  const durations: number[] = [];
  const logsCol: Array<{ timestamp: number; fields: TraceKV[] }[]> = [];
  const referencesCol: unknown[][] = [];
  const tagsCol: TraceKV[][] = [];

  for (const r of rows) {
    const label = kvArrayToObject(r.labels);

    // All span fields live in userData (Jaeger-format JSON blob)
    let ud: DataPrimeSpanUserData = {};
    if (typeof r.userData === 'string') {
      try {
        ud = JSON.parse(r.userData) as DataPrimeSpanUserData;
      } catch {
        // unparseable — will use empty defaults
      }
    } else if (r.userData && typeof r.userData === 'object') {
      ud = r.userData as DataPrimeSpanUserData;
    }

    const spanTagsObj = ud.tags ?? {};
    const spanTagsArr: TraceKV[] = Object.entries(spanTagsObj).map(([key, value]) => ({ key, value }));

    const processTagsObj = ud.process?.tags ?? {};
    const svcTagsArr: TraceKV[] = Object.entries(processTagsObj).map(([key, value]) => ({ key, value }));

    traceIDs.push(ud.traceID ?? '');
    spanIDs.push(ud.spanID ?? '');
    parentSpanIDs.push(ud.parentId ?? ''); // '' for root spans

    operationNames.push(ud.operationName ?? label['operationName'] ?? '');

    // serviceName from process object (Jaeger) or Coralogix label
    serviceNames.push(ud.process?.serviceName ?? label['serviceName'] ?? label['applicationName'] ?? '');

    // serviceNamespace from OTel process tag or Coralogix subsystem label
    const svcNs =
      (processTagsObj['service.namespace'] as string | undefined) ??
      label['subsystemName'] ?? '';
    serviceNamespaces.push(svcNs);

    // span.kind comes from Jaeger tags as "client", "server", "internal", etc.
    kinds.push((spanTagsObj['span.kind'] as string | undefined) ?? '');

    // Grafana's trace panel looks up n.s[statusCode] on the numeric SpanStatusCode enum:
    //   0 = UNSET, 1 = OK, 2 = ERROR
    // Sending any other value (including a string) causes `.toLowerCase()` to crash.
    const rawStatus = ((spanTagsObj['otel.status_code'] as string | undefined) ?? '').toUpperCase();
    const statusCode =
      rawStatus === 'ERROR' ? 2 :
      rawStatus === 'OK'    ? 1 :
                              0;
    statusCodes.push(statusCode);
    statusMessages.push((spanTagsObj['otel.status_description'] as string | undefined) ?? '');

    serviceTagsCol.push(svcTagsArr);

    // startTimeMillis already in ms; fall back to microsecond startTime ÷ 1000
    const startMs = ud.startTimeMillis ?? (ud.startTime !== undefined && ud.startTime !== null ? Math.floor(ud.startTime / 1000) : 0);
    startTimes.push(startMs);

    // duration is in microseconds → convert to milliseconds
    durations.push(ud.duration !== undefined && ud.duration !== null ? ud.duration / 1000 : 0);

    const sanitizedLogs = (Array.isArray(ud.logs) ? ud.logs : []).map((log) => ({
      ...log,
      fields: Array.isArray((log as { fields?: unknown }).fields) ? (log as { fields: Array<{ key: string; value: unknown }> }).fields : [],
    }));
    logsCol.push(sanitizedLogs);
    // parentSpanID already encodes CHILD_OF; passing ud.references (also CHILD_OF) causes duplicates
    // that confuse Grafana's critical-path algorithm — only keep genuine FOLLOWS_FROM refs.
    const followsFromRefs = Array.isArray(ud.references)
      ? ud.references.filter((ref) => (ref as { refType?: string }).refType === 'FOLLOWS_FROM')
      : [];
    referencesCol.push(followsFromRefs);
    tagsCol.push(spanTagsArr);
  }

  const frame = new MutableDataFrame({
    fields: [
      { name: 'traceID', type: FieldType.string, values: traceIDs },
      { name: 'spanID', type: FieldType.string, values: spanIDs },
      { name: 'parentSpanID', type: FieldType.string, values: parentSpanIDs },
      { name: 'operationName', type: FieldType.string, values: operationNames },
      { name: 'serviceName', type: FieldType.string, values: serviceNames },
      { name: 'serviceNamespace', type: FieldType.string, values: serviceNamespaces },
      { name: 'kind', type: FieldType.string, values: kinds },
      { name: 'statusCode', type: FieldType.number, values: statusCodes },
      { name: 'statusMessage', type: FieldType.string, values: statusMessages },
      { name: 'serviceTags', type: FieldType.other, values: serviceTagsCol },
      { name: 'startTime', type: FieldType.time, values: startTimes },
      { name: 'duration', type: FieldType.number, values: durations },
      { name: 'logs', type: FieldType.other, values: logsCol },
      { name: 'references', type: FieldType.other, values: referencesCol },
      { name: 'tags', type: FieldType.other, values: tagsCol },
    ],
  });
  frame.meta = { preferredVisualisationType: 'trace' };
  return frame;
}
