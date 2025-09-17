import React, { ChangeEvent } from 'react';
import { InlineField, InlineFieldRow, Input, Select, SecretInput } from '@grafana/ui';
import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { CoralogixDataSourceOptions, CoralogixSecureJsonData } from './types';

interface Props extends DataSourcePluginOptionsEditorProps<CoralogixDataSourceOptions, CoralogixSecureJsonData> {}

const regionOptions = [
  { label: 'EU1', value: 'eu1' },
  { label: 'EU2', value: 'eu2' },
  { label: 'US1', value: 'us1' },
  { label: 'US2', value: 'us2' },
  { label: 'AP1', value: 'ap1' },
  { label: 'IN1', value: 'in1' },
];

function urlForRegion(region?: string): string {
  const r = (region || 'eu1').trim();
  return `https://api.${r}.coralogix.com`;
}

export function ConfigEditor({ onOptionsChange, options }: Props) {
  const { jsonData, secureJsonData, secureJsonFields } = options;

  const onRegionChange = (value: string) => {
    onOptionsChange({
      ...options,
      jsonData: { ...jsonData, region: value, baseUrl: urlForRegion(value) },
    });
  };

  const onApiKeyChange = (e: React.FormEvent<HTMLInputElement>) => {
    const value = (e.currentTarget?.value ?? '') as string;
    onOptionsChange({
      ...options,
      secureJsonData: { ...(secureJsonData ?? {}), apiKey: value },
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
            options={regionOptions}
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
        <InlineField label="Coralogix Personal API Key" tooltip="Stored as a secret">
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
