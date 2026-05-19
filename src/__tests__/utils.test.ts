import {
  kvArrayToObject,
  parseTimestampToMs,
  collectRowsFromLines,
  looksLikeAggregation,
  toLogsFrame,
  toAggregateFrames,
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
