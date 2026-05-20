# Coralogix DataPrime Grafana Datasource

A Grafana datasource plugin for querying Coralogix logs and spans using the [DataPrime query language](https://coralogix.com/docs/dataprime-query-language/). Supports logs exploration, span/trace navigation, aggregation tables, time series panels, and pie/bar charts — all from a single query editor with inline autocomplete.

## Features

- **Logs** — queries render in Grafana's native Logs view with individual `d.<key>` columns visible in Log Details (severity, applicationname, subsystemname, body, traceId, spanId, and any custom fields in your log payload)
- **Spans/Traces** — `source spans` queries render in the Grafana Trace view; clicking a trace ID in Explore navigates directly to the span detail
- **Aggregations** — `countby`, `groupby`, and `aggregate` queries render as:
  - **Table** — multi-column results, multi-dimension groupby
  - **Pie / Bar chart** — single-dimension countby automatically pivots to wide format so each category becomes its own series
  - **Time series** — `timeseries` and `groupby roundTime(...)` queries return graph frames that work with Grafana's Time series and Bar chart panels
- **Autocomplete** — Monaco-based editor with context-aware suggestions: DataPrime commands, `source logs/spans`, field namespaces (`$d.`, `$l.`, `$m.`), known field names per namespace, and comparison operators
- **Secure configuration** — API key stored via Grafana's encrypted secret store; never sent to the browser; proxied through Grafana's backend
- **Multi-query** — multiple query rows execute in parallel with per-query cancellation when a newer request arrives

## Requirements

- Grafana >= 11.0
- Coralogix account with a Personal API Key (Team or Company scope)

## Installation

### Build from source

```bash
npm ci
npm run build
cp -r dist/* /opt/homebrew/var/lib/grafana/plugins/coralogix-dataprime-datasource/   # macOS Homebrew example
```

Allow the unsigned plugin in `grafana.ini`:

```ini
[plugins]
allow_loading_unsigned_plugins = coralogix-dataprime-datasource
```

Restart Grafana, then add the datasource under **Connections → Data sources → Add new**.

## Configuration

| Field | Description |
|---|---|
| Region | Selects the Coralogix API endpoint automatically (`https://api.<region>.coralogix.com`) |
| Base URL | Manual override — use if your region isn't listed |
| API Key | Coralogix Personal API Key, stored encrypted |

## Query examples

```dataprime
# All logs (last N in time range)
source logs

# Filter by severity
source logs | filter $m.severity in ('Error', 'Critical')

# Select specific fields
source logs | filter $d.env == 'production' | choose $m.timestamp, $l.applicationname, $d.message

# Count logs by application (renders as pie chart or table)
source logs | countby $l.applicationname

# Count errors by subsystem over time (renders as time series)
source logs | filter $m.severity == 'Error' | timeseries count() by $l.subsystemname

# Group spans by service (renders as table)
source spans | groupby $l.serviceName | aggregate count() as span_count

# Time-bucketed aggregation (renders as time series)
source logs | groupby roundTime($m.timestamp, '1h') as t, $l.applicationname | aggregate count() as cnt
```

## Autocomplete

The editor suggests:
- `source` targets: `logs`, `spans`
- DataPrime commands: `filter`, `groupby`, `countby`, `timeseries`, `choose`, `orderby`, `limit`, `aggregate`, and all others
- Field namespaces on `$`: `$d.`, `$l.`, `$m.`
- Field names within each namespace, filtered as you type
- Comparison operators after a complete field reference

## How results are rendered

| Query type | Grafana visualisation |
|---|---|
| `source logs` | Logs panel (native log view) |
| `source spans` | Trace panel |
| `countby <dim>` | Wide-format frame → Pie / Bar / Stat panel |
| `groupby <dims> \| aggregate ...` | Table |
| `timeseries ...` / `groupby roundTime(...)` | Time series / Bar chart |

If no `limit` clause is present the plugin appends `\| limit 15000` automatically.

## Provisioning

A ready-made provisioning file is included at `provisioning/datasource.yml`. Copy it to your Grafana provisioning directory and fill in your API key.

## Troubleshooting

**Plugin not visible after install** — verify the unsigned-plugins config and that the files are in the correct path, then restart Grafana.

**No data / 401 error** — check that the API key has at least read access and that the selected region matches your Coralogix account.

**Aggregation shows as a single pie slice** — make sure the query uses a single dimension and single value (e.g. `countby $l.applicationname`). Multi-dimension groupby results render as a table.

**Time series panel is blank** — confirm the query contains `timeseries` or `groupby roundTime(...)` and that the dashboard time range covers the data.

## License

MIT
