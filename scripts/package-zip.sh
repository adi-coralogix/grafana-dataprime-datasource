#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

npm run build
mkdir -p dist/release/coralogix-dataprime-datasource/img
cp -f dist/module.js dist/release/coralogix-dataprime-datasource/module.js
cp -f dist/plugin.json dist/release/coralogix-dataprime-datasource/plugin.json
if [ -f public/img/logo.svg ]; then
  mkdir -p dist/release/coralogix-dataprime-datasource/img
  cp -f public/img/logo.svg dist/release/coralogix-dataprime-datasource/img/logo.svg
fi
cd dist/release
zip -r coralogix-dataprime-datasource.zip coralogix-dataprime-datasource >/dev/null
 echo "Created $(pwd)/coralogix-dataprime-datasource.zip"
