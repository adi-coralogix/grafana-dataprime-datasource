# Coralogix DataPrime Grafana Datasource

A frontend-only Grafana datasource plugin for querying Coralogix DataPrime (logs/spans) directly from Grafana Explore. It supports inline autocomplete for DataPrime, secure API key storage, region-aware base URLs, and rendering logs in Grafana’s native Logs view.

## Features
- Query Coralogix DataPrime (`source logs`, `filter`, `choose`, `countby`, `groupby`, `timechart`)
- Autocomplete with DataPrime keywords, datasets, and fields
- Secure API key (SecretInput) and region-to-URL auto mapping
- Logs view support with fields in Log details (severity, applicationname, subsystemname, message)
- UTC-safe timestamp normalization
- Packaging script and provisioning examples

## Requirements
- Grafana >= 11.0
- Coralogix account and Personal API Key

## Quick Start
1. Build plugin:
```bash
npm ci
npm run build
```
2. Install plugin (example macOS Homebrew path):
```bash
cp -r dist/* /opt/homebrew/var/lib/grafana/plugins/coralogix-dataprime-datasource/
```
3. Allow unsigned plugin in grafana.ini:
```
[plugins]
allow_loading_unsigned_plugins = coralogix-dataprime-datasource
```
4. Restart Grafana and add datasource "Coralogix DataPrime".

## Configuration
- Region: sets Base URL automatically (`https://api.<region>.coralogix.com`)
- Base URL: optional override
- Coralogix Personal API Key: stored securely

## Usage
- Write queries in the single editor box. Under the hood the plugin forces DataPrime + Archive tier. If you do not include a `limit`, the plugin appends `| limit 15000`.
- Examples:
```
source logs
source logs | filter $m.severity in ('Error','Fatal') | choose $m.timestamp, $d.message
source logs | countby $m.severity
source logs | timechart count() by $m.severity
```

## Autocomplete
- Triggers on typing; offers datasets (logs, spans), commands (`filter`, `choose`, `groupby`, `sortby`, `limit`, `countby`, `timechart`), and fields (`$m.severity`, `$m.timestamp`, `$l.applicationname`, `$l.subsystemname`, `$d.message`).

## Packaging a Release
```bash
./scripts/package-zip.sh
# produces coralogix-dataprime-datasource.zip in dist/
```

## Provisioning Example
See `provisioning/datasource.yml` to pre-create the datasource.

## Troubleshooting
- Plugin not visible: verify unsigned plugins config and plugin path; restart Grafana.
- Autocomplete shows no suggestions: click into editor once, then type; ensure plugin assets are updated.
- Histogram banner: Grafana shows a notice for non-Loki/Elasticsearch datasources; use `timechart` queries for full series.

## License
MIT
