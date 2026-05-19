import { DataSource } from '../datasource';
import { DataSourceInstanceSettings, CoreApp } from '@grafana/data';
import { CoralogixDataSourceOptions } from '../types';
import { getBackendSrv, getTemplateSrv } from '@grafana/runtime';

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: jest.fn(),
  getTemplateSrv: jest.fn(),
}));

const mockPost = jest.fn();
const mockReplace = jest.fn((text: string) => text);

const INSTANCE_SETTINGS = {
  id: 42,
  jsonData: { region: 'eu1', baseUrl: 'https://api.eu1.coralogix.com' },
} as unknown as DataSourceInstanceSettings<CoralogixDataSourceOptions>;

function buildDataSource() {
  (getBackendSrv as jest.Mock).mockReturnValue({ post: mockPost });
  (getTemplateSrv as jest.Mock).mockReturnValue({ replace: mockReplace });
  return new DataSource(INSTANCE_SETTINGS);
}

function makeRange(from: string, to: string) {
  return {
    from: { toISOString: () => from } as unknown as import('@grafana/data').DateTime,
    to: { toISOString: () => to, valueOf: () => 1700000000000 } as unknown as import('@grafana/data').DateTime,
    raw: { from, to },
  };
}

function makeRequest(text: string, hide = false) {
  return {
    targets: [{ refId: 'A', text, hide }],
    range: makeRange('2023-11-14T00:00:00Z', '2023-11-14T23:59:59Z'),
  } as unknown as import('@grafana/data').DataQueryRequest<import('../types').CoralogixQuery>;
}

// ---------------------------------------------------------------------------
describe('DataSource.getDefaultQuery', () => {
  it('returns source logs', () => {
    const ds = buildDataSource();
    expect(ds.getDefaultQuery(CoreApp.Explore)).toEqual({ text: 'source logs' });
  });
});

// ---------------------------------------------------------------------------
describe('DataSource.filterQuery', () => {
  it('accepts non-empty queries', () => {
    const ds = buildDataSource();
    expect(ds.filterQuery({ refId: 'A', text: 'source logs' })).toBe(true);
  });

  it('rejects blank queries', () => {
    const ds = buildDataSource();
    expect(ds.filterQuery({ refId: 'A', text: '   ' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('DataSource.applyTemplateVariables', () => {
  it('replaces template variables in the query text', () => {
    mockReplace.mockReturnValueOnce('source logs | filter $d.env == "prod"');
    const ds = buildDataSource();
    const result = ds.applyTemplateVariables(
      { refId: 'A', text: 'source logs | filter $d.env == "${env}"' },
      {}
    );
    expect(result.text).toBe('source logs | filter $d.env == "prod"');
  });
});

// ---------------------------------------------------------------------------
describe('DataSource.testDatasource', () => {
  it('returns success', async () => {
    const ds = buildDataSource();
    await expect(ds.testDatasource()).resolves.toEqual({ status: 'success', message: 'OK' });
  });
});

// ---------------------------------------------------------------------------
describe('DataSource.query', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockReplace.mockImplementation((t: string) => t);
  });

  it('returns empty data when all targets are hidden', async () => {
    const ds = buildDataSource();
    const result = await ds.query(makeRequest('source logs', true));
    expect(result.data).toEqual([]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('injects default limit when query has none', async () => {
    const ndRow = { userData: '{"message":"hi"}', metadata: [], labels: [] };
    mockPost.mockResolvedValue(JSON.stringify({ result: { results: [ndRow] } }));
    const ds = buildDataSource();
    await ds.query(makeRequest('source logs'));

    const body = mockPost.mock.calls[0][1] as { query: string };
    expect(body.query).toMatch(/\| limit 15000/);
  });

  it('preserves an existing limit in the query', async () => {
    mockPost.mockResolvedValue(JSON.stringify({ result: { results: [] } }));
    const ds = buildDataSource();
    await ds.query(makeRequest('source logs | limit 500'));

    const body = mockPost.mock.calls[0][1] as { query: string };
    expect(body.query).toBe('source logs | limit 500');
  });

  it('uses the cx proxy path', async () => {
    mockPost.mockResolvedValue('');
    const ds = buildDataSource();
    await ds.query(makeRequest('source logs'));
    const url: string = mockPost.mock.calls[0][0];
    expect(url).toContain('/cx/');
  });

  it('parses NDJSON response into a logs frame', async () => {
    const ndRow = {
      userData: JSON.stringify({ message: 'test log' }),
      metadata: [
        { key: 'severity', value: 'Debug' },
        { key: 'timestamp', value: '1700000000000000' },
      ],
      labels: [],
    };
    mockPost.mockResolvedValue(JSON.stringify({ result: { results: [ndRow] } }));

    const ds = buildDataSource();
    const result = await ds.query(makeRequest('source logs'));

    expect(result.data).toHaveLength(1);
    const frame = result.data[0] as import('@grafana/data').MutableDataFrame;
    expect(frame.meta?.preferredVisualisationType).toBe('logs');
    expect(frame.refId).toBe('A');
  });

  it('parses severity aggregation into graph series', async () => {
    const rows = [
      { severity: 'Error', _count: 10 },
      { severity: 'Info', _count: 20 },
    ];
    mockPost.mockResolvedValue(JSON.stringify({ result: { results: rows } }));

    const ds = buildDataSource();
    const result = await ds.query(makeRequest('source logs | countby $m.severity'));

    expect(result.data).toHaveLength(2);
    for (const frame of result.data as import('@grafana/data').MutableDataFrame[]) {
      expect(frame.meta?.preferredVisualisationType).toBe('graph');
    }
  });

  it('falls back to a _raw frame on JSON parse failure', async () => {
    mockPost.mockResolvedValue('totally not json');

    const ds = buildDataSource();
    const result = await ds.query(makeRequest('source logs'));

    expect(result.data).toHaveLength(1);
    const frame = result.data[0] as import('@grafana/data').MutableDataFrame;
    expect(frame.fields[0].name).toBe('_raw');
    expect(frame.fields[0].values.get(0)).toBe('totally not json');
  });
});
