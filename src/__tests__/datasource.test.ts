import { DataSource } from '../datasource';
import type { DataSourceInstanceSettings } from '@grafana/data';
import { CoreApp } from '@grafana/data';
import type { CoralogixDataSourceOptions, CoralogixQuery } from '../types';
import { getBackendSrv, getTemplateSrv } from '@grafana/runtime';

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: jest.fn(),
  getTemplateSrv: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockPost = jest.fn();
const mockReplace = jest.fn((text: string) => text);

function makeSettings(
  overrides: Partial<CoralogixDataSourceOptions> = {}
): DataSourceInstanceSettings<CoralogixDataSourceOptions> {
  return {
    id: 42,
    jsonData: { region: 'eu1', baseUrl: 'https://api.eu1.coralogix.com', ...overrides },
  } as unknown as DataSourceInstanceSettings<CoralogixDataSourceOptions>;
}

function buildDs(settingsOverrides: Partial<CoralogixDataSourceOptions> = {}) {
  (getBackendSrv as jest.Mock).mockReturnValue({ post: mockPost });
  (getTemplateSrv as jest.Mock).mockReturnValue({ replace: mockReplace });
  return new DataSource(makeSettings(settingsOverrides));
}

function makeRange(from = '2023-11-14T00:00:00Z', to = '2023-11-14T23:59:59Z') {
  return {
    from: { toISOString: () => from } as unknown as import('@grafana/data').DateTime,
    to: {
      toISOString: () => to,
      valueOf: () => 1700000000000,
    } as unknown as import('@grafana/data').DateTime,
    raw: { from, to },
  };
}

function makeRequest(
  targets: Array<Partial<CoralogixQuery>> = [{ refId: 'A', text: 'source logs' }]
): import('@grafana/data').DataQueryRequest<CoralogixQuery> {
  return {
    targets: targets as CoralogixQuery[],
    range: makeRange(),
    requestId: 'test-req-1',
  } as unknown as import('@grafana/data').DataQueryRequest<CoralogixQuery>;
}

function ndText(rows: unknown[]): string {
  return JSON.stringify({ result: { results: rows } });
}

function jsonText(rows: unknown[]): string {
  return JSON.stringify({ result: { results: rows } });
}

function makeSpanRow() {
  return {
    userData: JSON.stringify({
      traceID: 'trace1',
      spanID: 'span1',
      parentId: '',
      operationName: 'GET /health',
      startTimeMillis: 1700000000000,
      duration: 5000, // µs → 5 ms
      process: { serviceName: 'my-service', tags: {} },
      tags: { 'span.kind': 'server' },
      references: [],
      logs: null,
    }),
    metadata: [
      { key: 'timestamp', value: '1700000000000000000' },
      { key: 'duration', value: '5000' },
    ],
    labels: [
      { key: 'applicationName', value: 'my-service' },
      { key: 'serviceName', value: 'my-service' },
      { key: 'subsystemName', value: 'http' },
    ],
  };
}

// ---------------------------------------------------------------------------
// getDefaultQuery
// ---------------------------------------------------------------------------
describe('DataSource.getDefaultQuery', () => {
  it('returns source logs', () => {
    expect(buildDs().getDefaultQuery(CoreApp.Explore)).toEqual({ text: 'source logs' });
  });
});

// ---------------------------------------------------------------------------
// filterQuery
// ---------------------------------------------------------------------------
describe('DataSource.filterQuery', () => {
  it('accepts non-empty queries', () => {
    expect(buildDs().filterQuery({ refId: 'A', text: 'source logs' })).toBe(true);
  });

  it('rejects blank queries', () => {
    expect(buildDs().filterQuery({ refId: 'A', text: '   ' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyTemplateVariables
// ---------------------------------------------------------------------------
describe('DataSource.applyTemplateVariables', () => {
  it('replaces template variables in the query text', () => {
    mockReplace.mockReturnValueOnce('source logs | filter $d.env == "prod"');
    const result = buildDs().applyTemplateVariables(
      { refId: 'A', text: 'source logs | filter $d.env == "${env}"' },
      {}
    );
    expect(result.text).toBe('source logs | filter $d.env == "prod"');
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------
describe('DataSource config validation', () => {
  it('throws when baseUrl is missing', async () => {
    const ds = buildDs({ baseUrl: undefined });
    await expect(ds.query(makeRequest())).rejects.toThrow(/Base URL is not configured/);
  });

  it('throws when baseUrl lacks a protocol', async () => {
    const ds = buildDs({ baseUrl: 'api.eu1.coralogix.com' });
    await expect(ds.query(makeRequest())).rejects.toThrow(/must start with https/i);
  });
});

// ---------------------------------------------------------------------------
// query — single target
// ---------------------------------------------------------------------------
describe('DataSource.query (single target)', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockReplace.mockImplementation((t: string) => t);
  });

  it('returns empty data when all targets are hidden', async () => {
    const ds = buildDs();
    const result = await ds.query(makeRequest([{ refId: 'A', text: 'source logs', hide: true }]));
    expect(result.data).toEqual([]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('injects default limit when query has none', async () => {
    mockPost.mockResolvedValue(ndText([]));
    await buildDs().query(makeRequest());
    const body = mockPost.mock.calls[0][1] as { query: string };
    expect(body.query).toMatch(/\| limit 15000/);
  });

  it('preserves an existing limit in the query', async () => {
    mockPost.mockResolvedValue(ndText([]));
    await buildDs().query(makeRequest([{ refId: 'A', text: 'source logs | limit 500' }]));
    const body = mockPost.mock.calls[0][1] as { query: string };
    expect(body.query).toBe('source logs | limit 500');
  });

  it('uses the /cx/ proxy path', async () => {
    mockPost.mockResolvedValue(ndText([]));
    await buildDs().query(makeRequest());
    expect(mockPost.mock.calls[0][0]).toContain('/cx/');
  });

  it('sets per-target requestId for cancellation', async () => {
    mockPost.mockResolvedValue(ndText([]));
    await buildDs().query(makeRequest());
    const opts = mockPost.mock.calls[0][2] as { requestId?: string };
    expect(opts.requestId).toContain('A');
  });

  it('parses NDJSON log rows into a logs frame', async () => {
    const row = {
      userData: JSON.stringify({ message: 'test log' }),
      metadata: [
        { key: 'severity', value: 'Debug' },
        { key: 'timestamp', value: '1700000000000000' },
      ],
      labels: [],
    };
    mockPost.mockResolvedValue(ndText([row]));

    const result = await buildDs().query(makeRequest());
    expect(result.data).toHaveLength(1);
    const frame = result.data[0] as import('@grafana/data').MutableDataFrame;
    expect(frame.meta?.preferredVisualisationType).toBe('logs');
    expect(frame.refId).toBe('A');
  });

  it('parses aggregation rows into graph series', async () => {
    const rows = [
      { severity: 'Error', _count: 10 },
      { severity: 'Info', _count: 20 },
    ];
    mockPost.mockResolvedValue(jsonText(rows));

    const result = await buildDs().query(
      makeRequest([{ refId: 'A', text: 'source logs | countby $m.severity' }])
    );
    expect(result.data.length).toBeGreaterThanOrEqual(2);
    const frame = result.data[0] as import('@grafana/data').MutableDataFrame;
    expect(frame.meta?.preferredVisualisationType).toBe('graph');
  });

  it('falls back to a _raw frame on JSON parse failure', async () => {
    mockPost.mockResolvedValue('totally not json');
    const result = await buildDs().query(makeRequest());
    expect(result.data).toHaveLength(1);
    const frame = result.data[0] as import('@grafana/data').MutableDataFrame;
    expect(frame.fields[0].name).toBe('_raw');
    expect(frame.fields[0].values.get(0)).toBe('totally not json');
  });
});

// ---------------------------------------------------------------------------
// query — multiple targets
// ---------------------------------------------------------------------------
describe('DataSource.query (multi-target)', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockReplace.mockImplementation((t: string) => t);
  });

  it('fans out all non-hidden targets in parallel', async () => {
    const logRow = {
      userData: '{"message":"hi"}',
      metadata: [{ key: 'timestamp', value: '1700000000000000' }],
      labels: [],
    };
    mockPost.mockResolvedValue(ndText([logRow]));

    const result = await buildDs().query(
      makeRequest([
        { refId: 'A', text: 'source logs' },
        { refId: 'B', text: 'source spans' },
      ])
    );

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(result.data).toHaveLength(2);
    const refIds = (result.data as import('@grafana/data').MutableDataFrame[]).map((f) => f.refId);
    expect(refIds).toContain('A');
    expect(refIds).toContain('B');
  });

  it('skips hidden targets', async () => {
    mockPost.mockResolvedValue(ndText([]));
    await buildDs().query(
      makeRequest([
        { refId: 'A', text: 'source logs', hide: true },
        { refId: 'B', text: 'source spans' },
      ])
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
    const opts = mockPost.mock.calls[0][2] as { requestId?: string };
    expect(opts.requestId).toContain('B');
  });

  it('each target gets a unique requestId containing its refId', async () => {
    mockPost.mockResolvedValue(ndText([]));
    await buildDs().query(
      makeRequest([
        { refId: 'A', text: 'source logs' },
        { refId: 'B', text: 'source spans' },
      ])
    );
    const ids = mockPost.mock.calls.map((c) => (c[2] as { requestId?: string }).requestId ?? '');
    expect(ids.some((id) => id.includes('A'))).toBe(true);
    expect(ids.some((id) => id.includes('B'))).toBe(true);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ---------------------------------------------------------------------------
// query — error handling
// ---------------------------------------------------------------------------
describe('DataSource.query (error handling)', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockReplace.mockImplementation((t: string) => t);
  });

  it('wraps 401 with a human-readable message', async () => {
    mockPost.mockRejectedValue({ status: 401 });
    await expect(buildDs().query(makeRequest())).rejects.toThrow(/API key/i);
  });

  it('wraps 403 with a human-readable message', async () => {
    mockPost.mockRejectedValue({ status: 403 });
    await expect(buildDs().query(makeRequest())).rejects.toThrow(/Permission denied/i);
  });

  it('wraps 429 with a human-readable message', async () => {
    mockPost.mockRejectedValue({ status: 429 });
    await expect(buildDs().query(makeRequest())).rejects.toThrow(/Rate limited/i);
  });

  it('wraps 504 with a human-readable message', async () => {
    mockPost.mockRejectedValue({ status: 504 });
    await expect(buildDs().query(makeRequest())).rejects.toThrow(/timeout/i);
  });

  it('returns empty array for cancelled requests without throwing', async () => {
    mockPost.mockRejectedValue({ cancelled: true });
    const result = await buildDs().query(makeRequest());
    expect(result.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// testDatasource
// ---------------------------------------------------------------------------
describe('DataSource.testDatasource', () => {
  beforeEach(() => mockPost.mockReset());

  it('returns error when baseUrl is missing', async () => {
    const ds = buildDs({ baseUrl: undefined });
    const result = await ds.testDatasource();
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/Base URL/i);
  });

  it('returns success when the probe request succeeds', async () => {
    mockPost.mockResolvedValue('');
    const result = await buildDs().testDatasource();
    expect(result.status).toBe('success');
    expect(result.message).toMatch(/connected/i);
  });

  it('returns error on 401', async () => {
    mockPost.mockRejectedValue({ status: 401 });
    const result = await buildDs().testDatasource();
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/API key/i);
  });

  it('returns error on 403', async () => {
    mockPost.mockRejectedValue({ status: 403 });
    const result = await buildDs().testDatasource();
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/Permission denied/i);
  });

  it('sends a minimal probe query', async () => {
    mockPost.mockResolvedValue('');
    await buildDs().testDatasource();
    const body = mockPost.mock.calls[0][1] as { query: string };
    expect(body.query).toBe('source logs | limit 1');
  });

  it('uses the /cx/ proxy path', async () => {
    mockPost.mockResolvedValue('');
    await buildDs().testDatasource();
    expect(mockPost.mock.calls[0][0]).toContain('/cx/');
  });
});

// ---------------------------------------------------------------------------
// query — trace routing
// ---------------------------------------------------------------------------
describe('DataSource.query (trace routing)', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockReplace.mockImplementation((t: string) => t);
  });

  it('routes "source spans" queries to a trace frame', async () => {
    mockPost.mockResolvedValue(ndText([makeSpanRow()]));
    const result = await buildDs().query(makeRequest([{ refId: 'A', text: 'source spans' }]));
    expect(result.data).toHaveLength(1);
    const frame = result.data[0] as import('@grafana/data').MutableDataFrame;
    expect(frame.meta?.preferredVisualisationType).toBe('trace');
  });

  it('trace frame carries the correct refId', async () => {
    mockPost.mockResolvedValue(ndText([makeSpanRow()]));
    const result = await buildDs().query(makeRequest([{ refId: 'T', text: 'source spans' }]));
    const frame = result.data[0] as import('@grafana/data').MutableDataFrame;
    expect(frame.refId).toBe('T');
  });

  it('trace frame contains all required fields', async () => {
    mockPost.mockResolvedValue(ndText([makeSpanRow()]));
    const result = await buildDs().query(makeRequest([{ refId: 'A', text: 'source spans' }]));
    const frame = result.data[0] as import('@grafana/data').MutableDataFrame;
    const names = frame.fields.map((f) => f.name);
    for (const req of ['traceID', 'spanID', 'parentSpanID', 'operationName', 'serviceName', 'startTime', 'duration', 'tags']) {
      expect(names).toContain(req);
    }
  });

  it('routes "source spans | countby $m.kind" to aggregation, not trace', async () => {
    const aggRow = { kind: 'server', _count: 10 };
    mockPost.mockResolvedValue(ndText([aggRow]));
    const result = await buildDs().query(
      makeRequest([{ refId: 'A', text: 'source spans | countby $m.kind' }])
    );
    const frame = result.data[0] as import('@grafana/data').MutableDataFrame;
    expect(frame.meta?.preferredVisualisationType).toBe('graph');
  });

  it('routes "source logs" queries to a logs frame, not trace', async () => {
    const logRow = {
      userData: '{"message":"test"}',
      metadata: [{ key: 'severity', value: 'Info' }, { key: 'timestamp', value: '1700000000000000' }],
      labels: [],
    };
    mockPost.mockResolvedValue(ndText([logRow]));
    const result = await buildDs().query(makeRequest([{ refId: 'A', text: 'source logs' }]));
    const frame = result.data[0] as import('@grafana/data').MutableDataFrame;
    expect(frame.meta?.preferredVisualisationType).toBe('logs');
  });

  it('injects default limit for span queries without an explicit limit', async () => {
    mockPost.mockResolvedValue(ndText([]));
    await buildDs().query(makeRequest([{ refId: 'A', text: 'source spans' }]));
    const body = mockPost.mock.calls[0][1] as { query: string };
    expect(body.query).toMatch(/\| limit 15000/);
  });
});
