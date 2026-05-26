# Coralogix DataPrime Grafana Datasource

A Grafana datasource plugin for querying Coralogix logs and spans using the [DataPrime query language](https://coralogix.com/docs/dataprime-query-language/). Supports logs exploration, span/trace navigation, aggregation tables, time series panels, pie/bar charts, and **Grafana alerting** — all from a single query editor with inline autocomplete.

## Features

- **Logs** — queries render in Grafana's native Logs view with individual `d.<key>` columns visible in Log Details (severity, applicationname, subsystemname, body, traceId, spanId, and any custom fields in your log payload)
- **Spans/Traces** — `source spans` queries render in the Grafana Trace view; clicking a trace ID in Explore navigates directly to the span detail
- **Aggregations** — `countby`, `groupby`, and `aggregate` queries render as:
  - **Table** — multi-column results, multi-dimension groupby
  - **Pie / Bar chart** — single-dimension `countby` automatically pivots to wide format so each category becomes its own series
  - **Time series** — `timeseries` and `groupby roundTime(...)` queries return graph frames that work with Grafana's Time series and Bar chart panels
- **Alerting** — backend plugin (Go) handles server-side query evaluation so Grafana alert rules can threshold on any DataPrime aggregation query without a browser
- **Autocomplete** — Monaco-based editor with context-aware suggestions: DataPrime commands, `source logs/spans`, field namespaces (`$d.`, `$l.`, `$m.`), known field names per namespace, and comparison operators
- **Secure configuration** — API key stored via Grafana's encrypted secret store; never exposed to the browser; sent only from the Grafana backend to the Coralogix API
- **Multi-query** — multiple query rows execute in parallel with per-query cancellation when a newer request arrives

## Requirements

- Grafana >= 11.0
- Go >= 1.21 (to build from source)
- Coralogix account with a Personal API Key (Team or Company scope)

## Installation

### Build from source

```bash
npm ci
npm run build   # compiles TypeScript frontend + Go backend binary
cp -r dist/* /opt/homebrew/var/lib/grafana/plugins/coralogix-dataprime-datasource/   # macOS Homebrew example
```

`npm run build` runs webpack for the frontend and then `go build` for the backend binary. The binary is named `gpx_coralogix-dataprime-datasource_<os>_<arch>` and must be present alongside `module.js` in the plugin directory.

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

# Count logs by application (renders as pie chart or table; alertable)
source logs | countby $l.applicationname

# Count errors by subsystem over time (renders as time series; alertable)
source logs | filter $m.severity == 'Error' | timeseries count() by $l.subsystemname

# Group spans by service (renders as table)
source spans | groupby $l.serviceName | aggregate count() as span_count

# Time-bucketed aggregation (renders as time series)
source logs | groupby roundTime($m.timestamp, '1h') as t, $l.applicationname | aggregate count() as cnt
```

## Alerting

Because the plugin includes a Go backend, Grafana's alerting engine can evaluate DataPrime queries server-side on a schedule. To create an alert rule:

1. Go to **Alerting → Alert rules → New alert rule**
2. Set the datasource to **Coralogix DataPrime**
3. Write an aggregation query (e.g. `source logs | filter $m.severity == 'Critical' | countby $l.applicationname`)
4. Add a **Reduce** expression to pick a function (Last, Mean, Max, etc.)
5. Add a **Threshold** expression and set your condition (e.g. "Is above 10")
6. Configure the evaluation interval, folder, and notification contact point

Any query that returns numeric values can be used in an alert rule. Single-dimension `countby` results are automatically pivoted so each category fires as a separate alert instance.

## How results are rendered

| Query type | Grafana visualisation |
|---|---|
| `source logs` | Logs panel (native log view) |
| `source spans` | Trace panel |
| `countby <dim>` | Wide-format frame → Pie / Bar / Stat panel |
| `groupby <dims> \| aggregate ...` | Table |
| `timeseries ...` / `groupby roundTime(...)` | Time series / Bar chart |

If no `limit` clause is present the plugin appends `| limit 15000` automatically.

## Autocomplete

The editor suggests:
- `source` targets: `logs`, `spans`
- DataPrime commands: `filter`, `groupby`, `countby`, `timeseries`, `choose`, `orderby`, `limit`, `aggregate`, and all others
- Field namespaces on `$`: `$d.`, `$l.`, `$m.`
- Field names within each namespace, filtered as you type
- Comparison operators after a complete field reference

## Architecture

The plugin has two components:

| Component | Language | Role |
|---|---|---|
| Frontend | TypeScript / React | Query editor, autocomplete, frame rendering in the browser |
| Backend | Go | Alert evaluation, `CheckHealth`, server-side query execution |

The Go backend (`pkg/`) uses the [Grafana Plugin SDK for Go](https://github.com/grafana/grafana-plugin-sdk-go). It calls the DataPrime API directly using the API key from Grafana's encrypted secret store and produces the same data frames as the frontend, ensuring consistent results whether a query is run from a panel or an alert rule.

## Provisioning

A ready-made provisioning file is included at `provisioning/datasource.yml`. Copy it to your Grafana provisioning directory and fill in your API key.

## Troubleshooting

**Plugin not visible after install** — verify the unsigned-plugins config and that both `module.js` and the `gpx_*` binary are in the plugin directory, then restart Grafana.

**Alerting shows "Not supported"** — the Go binary is missing from the plugin directory or `backend: true` is not set in `plugin.json`. Re-run `npm run build` and copy all `dist/` files.

**No data / 401 error** — check that the API key has at least read access and that the selected region matches your Coralogix account.

**Aggregation shows as a single pie slice** — make sure the query uses a single dimension and single value (e.g. `countby $l.applicationname`). Multi-dimension groupby results render as a table.

**Time series panel is blank** — confirm the query contains `timeseries` or `groupby roundTime(...)` and that the dashboard time range covers the data.

**Alert has extra zero-valued instances** — this can happen if the DataPrime response includes metadata rows (`queryId`, `statistics`, `warning`). Update to the latest version of the plugin, which filters these automatically.

## License

MIT
