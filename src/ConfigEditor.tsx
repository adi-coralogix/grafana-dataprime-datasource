import React, { useEffect } from 'react';
import type { ChangeEvent } from 'react';
import { InlineField, InlineFieldRow, Input, Select, SecretInput } from '@grafana/ui';
import type { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import type { CoralogixDataSourceOptions, CoralogixSecureJsonData } from './types';

type Props = DataSourcePluginOptionsEditorProps<CoralogixDataSourceOptions, CoralogixSecureJsonData>;

const REGION_OPTIONS = [
  { label: 'EU1', value: 'eu1' },
  { label: 'EU2', value: 'eu2' },
  { label: 'US1', value: 'us1' },
  { label: 'US2', value: 'us2' },
  { label: 'AP1', value: 'ap1' },
  { label: 'IN1', value: 'in1' },
];

function urlForRegion(region?: string): string {
  return `https://api.${(region ?? 'eu1').trim()}.coralogix.com`;
}

export function ConfigEditor({ onOptionsChange, options }: Props) {
  const { jsonData, secureJsonData, secureJsonFields } = options;

  // Ensure baseUrl is always initialised so the Grafana proxy route can resolve it
  useEffect(() => {
    if (!jsonData.baseUrl) {
      onOptionsChange({
        ...options,
        jsonData: {
          ...jsonData,
          region: jsonData.region || 'eu1',
          baseUrl: urlForRegion(jsonData.region),
        },
      });
    }
    // Run only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRegionChange = (value: string) => {
    onOptionsChange({
      ...options,
      jsonData: { ...jsonData, region: value, baseUrl: urlForRegion(value) },
    });
  };

  const onApiKeyChange = (e: React.FormEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      secureJsonData: { ...(secureJsonData ?? {}), apiKey: e.currentTarget.value },
    });
  };

  const onApiKeyReset = () => {
    onOptionsChange({
      ...options,
      secureJsonData: { ...(secureJsonData ?? {}), apiKey: '' },
      secureJsonFields: { ...(options.secureJsonFields ?? {}), apiKey: false },
    });
  };

  const onBaseUrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      jsonData: { ...jsonData, baseUrl: event.target.value },
    });
  };

  return (
    <div className="gf-form-group">
      <InlineFieldRow>
        <InlineField label="Region" tooltip="Coralogix region">
          <Select
            width={20}
            value={jsonData.region || 'eu1'}
            options={REGION_OPTIONS}
            onChange={(option) => onRegionChange(option.value!)}
          />
        </InlineField>
        <InlineField label="Base URL" tooltip="Coralogix API base URL (auto-set by region)">
          <Input
            width={40}
            value={jsonData.baseUrl || urlForRegion(jsonData.region)}
            onChange={onBaseUrlChange}
            placeholder={urlForRegion(jsonData.region)}
          />
        </InlineField>
      </InlineFieldRow>
      <InlineFieldRow>
        <InlineField label="Coralogix Personal API Key" tooltip="Stored encrypted; injected by the Grafana proxy">
          <SecretInput
            width={40}
            isConfigured={Boolean(secureJsonFields?.apiKey)}
            value={secureJsonData?.apiKey || ''}
            onChange={onApiKeyChange}
            onReset={onApiKeyReset}
            placeholder="cx_..."
          />
        </InlineField>
      </InlineFieldRow>
    </div>
  );
}
