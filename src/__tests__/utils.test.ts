import {
  kvArrayToObject,
  parseTimestampToMs,
  collectRowsFromLines,
  looksLikeAggregation,
  toLogsFrame,
  toAggregateFrames,
  isSpanQuery,
  nanosToMs,
  toTraceFrame,
} from '../utils';
import type { DataPrimeKeyValue, DataPrimeResult } from '../types';
import { FieldType } from '@grafana/data';

// ---------------------------------------------------------------------------
// kvArrayToObject
// ---------------------------------------------------------------------------
describe('kvArrayToObject', () => {
  it('converts a key-value array to a plain object', () => {
    const input: DataPrimeKeyValue[] = [
      { key: 'severity', value: 'Info' },
      { key: 'timestamp', value: '1700000000000000' },
    ];
    expect(kvArrayToObject(input)).toEqual({ severity: 'Info', timestamp: '1700000000000000' });
  });

  it('returns empty object for undefined input', () => {
    expect(kvArrayToObject(undefined)).toEqual({});
  });

  it('skips entries without a key', () => {
    const input = [{ key: '', value: 'x' }, { key: 'a', value: 'b' }] as DataPrimeKeyValue[];
    expect(kvArrayToObject(input)).toEqual({ a: 'b' });
  });
});

// ---------------------------------------------------------------------------
// parseTimestampToMs
// ---------------------------------------------------------------------------
describe('parseTimestampToMs', () => {
  it('parses microsecond numeric string', () => {
    expect(parseTimestampToMs('1700000000000000')).toBe(1700000000000);
  });

  it('parses microsecond number', () => {
    expect(parseTimestampToMs(1700000000000000)).toBe(1700000000000);
  });

  it('parses ISO string with timezone', () => {
    expect(parseTimestampToMs('2023-11-14T22:13:20.000Z')).toBe(Date.parse('2023-11-14T22:13:20.000Z'));
  });

  it('treats ISO string without timezone as UTC', () => {
    expect(parseTimestampToMs('2023-11-14T22:13:20')).toBe(Date.parse('2023-11-14T22:13:20Z'));
  });

  it('returns Date.now() for undefined input', () => {
    const before = Date.now();
    const result = parseTimestampToMs(undefined);
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it('returns Date.now() for unparseable string', () => {
    const before = Date.now();
    const result = parseTimestampToMs('not-a-date');
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// collectRowsFromLines
// ---------------------------------------------------------------------------
describe('collectRowsFromLines', () => {
  it('collects rows from NDJSON lines (result format)', () => {
    const row = { userData: '{"message":"hello"}', metadata: [], labels: [] };
    const line = JSON.stringify({ result: { results: [row] } });
    expect(collectRowsFromLines([line])).toEqual([row]);
  });

  it('collects rows from NDJSON lines (response format)', () => {
    const row = { userData: '{"message":"world"}' };
    const line = JSON.stringify({ response: { results: { results: [row] } } });
    expect(collectRowsFromLines([line])).toEqual([row]);
  });

  it('skips invalid JSON lines without throwing', () => {
    expect(collectRowsFromLines(['{invalid json}', ''])).toEqual([]);
  });

  it('flattens rows across multiple lines', () => {
    const row1 = { userData: 'a' };
    const row2 = { userData: 'b' };
    const line1 = JSON.stringify({ result: { results: [row1] } });
    const line2 = JSON.stringify({ result: { results: [row2] } });
    expect(collectRowsFromLines([line1, line2])).toEqual([row1, row2]);
  });
});

// ---------------------------------------------------------------------------
// looksLikeAggregation
// ---------------------------------------------------------------------------
describe('looksLikeAggregation', () => {
  it('returns true for rows with _count and no metadata array', () => {
    const rows: DataPrimeResult[] = [{ _count: 42, severity: 'Error' }];
    expect(looksLikeAggregation(rows)).toBe(true);
  });

  it('returns true for rows with count (not _count)', () => {
    const rows: DataPrimeResult[] = [{ count: 5, severity: 'Info' }];
    expect(looksLikeAggregation(rows)).toBe(true);
  });

  it('returns true even without a severity field (generic countby)', () => {
    const rows: DataPrimeResult[] = [{ applicationname: 'myapp', _count: 10 }];
    expect(looksLikeAggregation(rows)).toBe(true);
  });

  it('returns false when metadata is an array (log rows)', () => {
    const rows: DataPrimeResult[] = [{ _count: 1, severity: 'Warn', metadata: [] }];
    expect(looksLikeAggregation(rows)).toBe(false);
  });

  it('returns false for plain log rows', () => {
    const rows: DataPrimeResult[] = [{ userData: '{"message":"hi"}', metadata: [] }];
    expect(looksLikeAggregation(rows)).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(looksLikeAggregation([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toLogsFrame
// ---------------------------------------------------------------------------
describe('toLogsFrame', () => {
  it('builds a logs DataFrame with expected fields', () => {
    const rows: DataPrimeResult[] = [
      {
        userData: JSON.stringify({ message: 'hello world', body: 'body text' }),
        metadata: [
          { key: 'severity', value: 'Info' },
          { key: 'timestamp', value: '1700000000000000' },
        ],
        labels: [
          { key: 'applicationname', value: 'myapp' },
          { key: 'subsystemname', value: 'api' },
        ],
      },
    ];

    const frame = toLogsFrame(rows);
    expect(frame.meta?.preferredVisualisationType).toBe('logs');

    const fieldNames = frame.fields.map((f) => f.name);
    expect(fieldNames).toEqual(['time', 'line', 'severity', 'applicationname', 'subsystemname', 'message', 'body']);

    const timeField = frame.fields.find((f) => f.name === 'time')!;
    expect(timeField.type).toBe(FieldType.time);
    expect(timeField.values.get(0)).toBe(1700000000000);

    expect(frame.fields.find((f) => f.name === 'severity')!.values.get(0)).toBe('Info');
    expect(frame.fields.find((f) => f.name === 'applicationname')!.values.get(0)).toBe('myapp');
    expect(frame.fields.find((f) => f.name === 'message')!.values.get(0)).toBe('hello world');
    expect(frame.fields.find((f) => f.name === 'body')!.values.get(0)).toBe('body text');
  });

  it('handles malformed userData gracefully', () => {
    const rows: DataPrimeResult[] = [{ userData: '{not valid json}' }];
    const frame = toLogsFrame(rows);
    expect(frame.fields.find((f) => f.name === 'message')!.values.get(0)).toBe('{not valid json}');
  });

  it('handles object userData', () => {
    const rows: DataPrimeResult[] = [{ userData: { message: 'from object' } }];
    const frame = toLogsFrame(rows);
    expect(frame.fields.find((f) => f.name === 'message')!.values.get(0)).toContain('from object');
  });

  it('returns an empty frame for empty input', () => {
    const frame = toLogsFrame([]);
    expect(frame.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// toAggregateFrames
// ---------------------------------------------------------------------------
describe('toAggregateFrames', () => {
  const AT_MS = 1700000000000;

  it('creates one frame per unique dimension combination', () => {
    const rows: DataPrimeResult[] = [
      { severity: 'Error', _count: 10 },
      { severity: 'Info', _count: 25 },
    ];
    const frames = toAggregateFrames(rows, AT_MS);
    expect(frames).toHaveLength(2);
  });

  it('sets labels from all non-count fields', () => {
    const rows: DataPrimeResult[] = [{ severity: 'Error', _count: 3 }];
    const frames = toAggregateFrames(rows, AT_MS);
    const valueField = frames[0].fields.find((f) => f.name === 'value')!;
    expect(valueField.labels).toEqual({ severity: 'Error' });
  });

  it('sums counts for duplicate dimension combinations', () => {
    const rows: DataPrimeResult[] = [
      { severity: 'Warn', _count: 3 },
      { severity: 'Warn', count: 7 },
    ];
    const frames = toAggregateFrames(rows, AT_MS);
    expect(frames).toHaveLength(1);
    expect(frames[0].fields.find((f) => f.name === 'value')!.values.get(0)).toBe(10);
  });

  it('handles multi-dimensional aggregations', () => {
    const rows: DataPrimeResult[] = [
      { applicationname: 'app1', severity: 'Error', _count: 5 },
      { applicationname: 'app1', severity: 'Info', _count: 15 },
      { applicationname: 'app2', severity: 'Error', _count: 2 },
    ];
    const frames = toAggregateFrames(rows, AT_MS);
    expect(frames).toHaveLength(3);
  });

  it('handles non-severity dimension (countby applicationname)', () => {
    const rows: DataPrimeResult[] = [
      { applicationname: 'frontend', _count: 100 },
      { applicationname: 'backend', _count: 200 },
    ];
    const frames = toAggregateFrames(rows, AT_MS);
    expect(frames).toHaveLength(2);
    const names = frames.map((f) => f.name).sort();
    expect(names).toEqual(['applicationname="backend"', 'applicationname="frontend"']);
  });

  it('is stable: dimension order in source row does not affect grouping', () => {
    const rows: DataPrimeResult[] = [
      { severity: 'Error', app: 'x', _count: 1 },
      { app: 'x', severity: 'Error', _count: 2 }, // same dims, different key order
    ];
    const frames = toAggregateFrames(rows, AT_MS);
    expect(frames).toHaveLength(1);
    expect(frames[0].fields.find((f) => f.name === 'value')!.values.get(0)).toBe(3);
  });

  it('sets preferredVisualisationType to graph', () => {
    const rows: DataPrimeResult[] = [{ severity: 'Debug', _count: 1 }];
    expect(toAggregateFrames(rows, AT_MS)[0].meta?.preferredVisualisationType).toBe('graph');
  });

  it('pins the time point to atMs', () => {
    const rows: DataPrimeResult[] = [{ severity: 'Info', _count: 1 }];
    expect(toAggregateFrames(rows, AT_MS)[0].fields.find((f) => f.name === 'time')!.values.get(0)).toBe(AT_MS);
  });

  it('uses "aggregation" as name when there are no dimension fields', () => {
    const rows: DataPrimeResult[] = [{ _count: 99 }];
    expect(toAggregateFrames(rows, AT_MS)[0].name).toBe('aggregation');
  });
});

// ---------------------------------------------------------------------------
// isSpanQuery
// ---------------------------------------------------------------------------
describe('isSpanQuery', () => {
  it('returns true for "source spans"', () => {
    expect(isSpanQuery('source spans')).toBe(true);
  });

  it('returns true for spans with pipe operations', () => {
    expect(isSpanQuery('source spans | filter $m.kind == "server"')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSpanQuery('SOURCE SPANS | limit 100')).toBe(true);
  });

  it('returns false for "source logs"', () => {
    expect(isSpanQuery('source logs | limit 100')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isSpanQuery('')).toBe(false);
  });

  it('does not match "spans" without "source"', () => {
    expect(isSpanQuery('filter $m.spans == 1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nanosToMs
// ---------------------------------------------------------------------------
describe('nanosToMs', () => {
  it('converts 19-digit epoch nanoseconds to milliseconds', () => {
    expect(nanosToMs('1700000000000000000')).toBe(1700000000000);
  });

  it('accepts a number input', () => {
    // 1_234_000_000_000 ns = 1_234_000 ms
    expect(nanosToMs(1234000000000000)).toBe(1234000000);
  });

  it('converts a short duration (12345678 ns → 12 ms)', () => {
    expect(nanosToMs('12345678')).toBe(12);
  });

  it('returns 0 for values under 1 ms (≤6 digits)', () => {
    expect(nanosToMs('999999')).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(nanosToMs(undefined)).toBe(0);
  });

  it('returns 0 for non-numeric string', () => {
    expect(nanosToMs('not-a-number')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// toTraceFrame
// ---------------------------------------------------------------------------

// Matches the real DataPrime response: all span fields live in userData (Jaeger-format JSON).
// Labels use camelCase with capitals (applicationName, serviceName, subsystemName).
function makeSpanRow(overrides: Partial<DataPrimeResult> = {}): DataPrimeResult {
  return {
    userData: JSON.stringify({
      traceID: 'abc123trace',
      spanID: 'def456span',
      parentId: '',
      operationName: 'GET /api/users',
      startTimeMillis: 1700000000000,
      startTime: 1700000000000780, // microseconds
      duration: 2564,              // microseconds → 2.564 ms
      process: {
        serviceName: 'my-service',
        tags: { 'service.namespace': 'my-namespace', 'k8s.pod.name': 'pod-abc' },
      },
      tags: { 'span.kind': 'server', 'http.method': 'GET', 'http.status_code': '200' },
      references: [],
      logs: null,
    }),
    metadata: [
      { key: 'timestamp', value: '1700000000000780000' },
      { key: 'duration', value: '2564' },
    ],
    labels: [
      { key: 'applicationName', value: 'my-service' },
      { key: 'serviceName', value: 'my-service' },
      { key: 'subsystemName', value: 'api' },
      { key: 'operationName', value: 'GET /api/users' },
    ],
    ...overrides,
  };
}

describe('toTraceFrame', () => {
  it('sets preferredVisualisationType to trace', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    expect(frame.meta?.preferredVisualisationType).toBe('trace');
  });

  it('maps traceID and spanID from userData', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    expect(frame.fields.find((f) => f.name === 'traceID')!.values.get(0)).toBe('abc123trace');
    expect(frame.fields.find((f) => f.name === 'spanID')!.values.get(0)).toBe('def456span');
  });

  it('maps parentSpanID — empty string for root spans', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    expect(frame.fields.find((f) => f.name === 'parentSpanID')!.values.get(0)).toBe('');
  });

  it('maps parentSpanID for child spans', () => {
    const ud = JSON.parse(makeSpanRow().userData as string);
    ud.parentId = 'parent789';
    const row = makeSpanRow({ userData: JSON.stringify(ud) });
    const frame = toTraceFrame([row]);
    expect(frame.fields.find((f) => f.name === 'parentSpanID')!.values.get(0)).toBe('parent789');
  });

  it('maps operationName from userData.operationName', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    expect(frame.fields.find((f) => f.name === 'operationName')!.values.get(0)).toBe('GET /api/users');
  });

  it('maps serviceName from userData.process.serviceName', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    expect(frame.fields.find((f) => f.name === 'serviceName')!.values.get(0)).toBe('my-service');
  });

  it('maps serviceNamespace from process tags service.namespace', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    expect(frame.fields.find((f) => f.name === 'serviceNamespace')!.values.get(0)).toBe('my-namespace');
  });

  it('falls back serviceNamespace to subsystemName label', () => {
    const ud = JSON.parse(makeSpanRow().userData as string);
    delete ud.process.tags['service.namespace'];
    const row = makeSpanRow({ userData: JSON.stringify(ud) });
    const frame = toTraceFrame([row]);
    expect(frame.fields.find((f) => f.name === 'serviceNamespace')!.values.get(0)).toBe('api');
  });

  it('maps kind from userData.tags["span.kind"]', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    expect(frame.fields.find((f) => f.name === 'kind')!.values.get(0)).toBe('server');
  });

  it('maps client kind correctly', () => {
    const ud = JSON.parse(makeSpanRow().userData as string);
    ud.tags['span.kind'] = 'client';
    const frame = toTraceFrame([makeSpanRow({ userData: JSON.stringify(ud) })]);
    expect(frame.fields.find((f) => f.name === 'kind')!.values.get(0)).toBe('client');
  });

  it('defaults statusCode to 0 (UNSET) when otel tag absent', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    expect(frame.fields.find((f) => f.name === 'statusCode')!.values.get(0)).toBe(0);
  });

  it('maps otel.status_code ERROR to 2', () => {
    const ud = JSON.parse(makeSpanRow().userData as string);
    ud.tags['otel.status_code'] = 'ERROR';
    const frame = toTraceFrame([makeSpanRow({ userData: JSON.stringify(ud) })]);
    expect(frame.fields.find((f) => f.name === 'statusCode')!.values.get(0)).toBe(2);
  });

  it('maps otel.status_code OK to 1', () => {
    const ud = JSON.parse(makeSpanRow().userData as string);
    ud.tags['otel.status_code'] = 'OK';
    const frame = toTraceFrame([makeSpanRow({ userData: JSON.stringify(ud) })]);
    expect(frame.fields.find((f) => f.name === 'statusCode')!.values.get(0)).toBe(1);
  });

  it('uses startTimeMillis directly (already in ms)', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    expect(frame.fields.find((f) => f.name === 'startTime')!.values.get(0)).toBe(1700000000000);
  });

  it('falls back to microsecond startTime ÷ 1000 when startTimeMillis absent', () => {
    const ud = JSON.parse(makeSpanRow().userData as string);
    delete ud.startTimeMillis;
    ud.startTime = 1700000000000780; // microseconds
    const frame = toTraceFrame([makeSpanRow({ userData: JSON.stringify(ud) })]);
    // 1700000000000780 / 1000 = 1700000000000.78 → floor = 1700000000000
    expect(frame.fields.find((f) => f.name === 'startTime')!.values.get(0)).toBe(1700000000000);
  });

  it('converts duration from microseconds to milliseconds', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    // 2564 µs / 1000 = 2.564 ms
    expect(frame.fields.find((f) => f.name === 'duration')!.values.get(0)).toBeCloseTo(2.564, 2);
  });

  it('stores tags as a raw JS array (FieldType.other)', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    const tagsField = frame.fields.find((f) => f.name === 'tags')!;
    expect(tagsField.type).toBe(FieldType.other);
    const tagArr = tagsField.values.get(0) as Array<{ key: string; value: unknown }>;
    expect(Array.isArray(tagArr)).toBe(true);
    expect(tagArr.find((t) => t.key === 'http.method')?.value).toBe('GET');
    expect(tagArr.find((t) => t.key === 'span.kind')?.value).toBe('server');
  });

  it('stores serviceTags from process.tags as a raw JS array (FieldType.other)', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    const field = frame.fields.find((f) => f.name === 'serviceTags')!;
    expect(field.type).toBe(FieldType.other);
    const arr = field.values.get(0) as Array<{ key: string; value: unknown }>;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.find((t) => t.key === 'k8s.pod.name')?.value).toBe('pod-abc');
  });

  it('stores logs (FieldType.other) — empty when null in userData', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    expect(frame.fields.find((f) => f.name === 'logs')!.type).toBe(FieldType.other);
    expect(frame.fields.find((f) => f.name === 'logs')!.values.get(0)).toEqual([]);
  });

  it('passes references from userData to the frame as-is (FieldType.other)', () => {
    const ud = JSON.parse(makeSpanRow().userData as string);
    ud.references = [{ traceID: 'abc123trace', spanID: 'parent789', refType: 'CHILD_OF' }];
    const frame = toTraceFrame([makeSpanRow({ userData: JSON.stringify(ud) })]);
    const refs = frame.fields.find((f) => f.name === 'references')!.values.get(0) as unknown[];
    expect(refs).toHaveLength(1);
    expect((refs[0] as { refType: string }).refType).toBe('CHILD_OF');
  });

  it('handles malformed userData gracefully — all fields default to empty', () => {
    const frame = toTraceFrame([makeSpanRow({ userData: '{not valid json}' })]);
    expect(frame.fields.find((f) => f.name === 'traceID')!.values.get(0)).toBe('');
    expect(frame.fields.find((f) => f.name === 'tags')!.values.get(0)).toEqual([]);
  });

  it('handles object userData directly', () => {
    const frame = toTraceFrame([makeSpanRow({
      userData: { traceID: 'obj-trace', spanID: 'obj-span', tags: { 'db.type': 'sql' } },
    })]);
    expect(frame.fields.find((f) => f.name === 'traceID')!.values.get(0)).toBe('obj-trace');
    const tagArr = frame.fields.find((f) => f.name === 'tags')!.values.get(0) as Array<{ key: string; value: unknown }>;
    expect(tagArr.find((t) => t.key === 'db.type')?.value).toBe('sql');
  });

  it('returns an empty frame for empty input', () => {
    const frame = toTraceFrame([]);
    expect(frame.length).toBe(0);
    expect(frame.meta?.preferredVisualisationType).toBe('trace');
  });

  it('handles multiple spans in a single frame', () => {
    const ud2 = JSON.parse(makeSpanRow().userData as string);
    ud2.spanID = 'span2';
    ud2.parentId = 'def456span';
    const frame = toTraceFrame([makeSpanRow(), makeSpanRow({ userData: JSON.stringify(ud2) })]);
    expect(frame.length).toBe(2);
    expect(frame.fields.find((f) => f.name === 'spanID')!.values.get(1)).toBe('span2');
    expect(frame.fields.find((f) => f.name === 'parentSpanID')!.values.get(1)).toBe('def456span');
  });

  it('contains all required Grafana trace panel fields', () => {
    const frame = toTraceFrame([makeSpanRow()]);
    const names = frame.fields.map((f) => f.name);
    for (const required of [
      'traceID', 'spanID', 'parentSpanID', 'operationName', 'serviceName',
      'serviceNamespace', 'kind', 'statusCode', 'statusMessage',
      'serviceTags', 'startTime', 'duration', 'logs', 'references', 'tags',
    ]) {
      expect(names).toContain(required);
    }
  });
});
