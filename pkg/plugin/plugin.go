package plugin

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

const defaultLimit = 15000

var (
	limitRe   = regexp.MustCompile(`(?i)\blimit\s+\d+`)
	traceIDRe = regexp.MustCompile(`(?i)^[0-9a-f]{16,64}$`)
)

// Datasource is the backend implementation of the Coralogix DataPrime plugin.
// It handles QueryData (used by Grafana alerting and Explore) and CheckHealth.
type Datasource struct {
	httpClient *http.Client
	baseURL    string
	apiKey     string
}

// NewDatasource is called by Grafana once per configured datasource instance.
func NewDatasource(_ context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	var jsonData struct {
		BaseURL string `json:"baseUrl"`
		Region  string `json:"region"`
	}
	if err := json.Unmarshal(settings.JSONData, &jsonData); err != nil {
		return nil, fmt.Errorf("parsing jsonData: %w", err)
	}

	baseURL := jsonData.BaseURL
	if baseURL == "" && jsonData.Region != "" {
		baseURL = fmt.Sprintf("https://api.%s.coralogix.com", jsonData.Region)
	}

	apiKey := settings.DecryptedSecureJSONData["apiKey"]

	return &Datasource{
		httpClient: &http.Client{Timeout: 120 * time.Second},
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiKey:     apiKey,
	}, nil
}

// Dispose is called when the instance is being removed (datasource update/delete).
func (d *Datasource) Dispose() {}

// QueryData handles all queries — used by panels, Explore, and alert rule evaluation.
func (d *Datasource) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	response := backend.NewQueryDataResponse()
	for _, q := range req.Queries {
		response.Responses[q.RefID] = d.runQuery(ctx, q)
	}
	return response, nil
}

type queryModel struct {
	Text  string `json:"text"`
	Query string `json:"query"` // traceID injected by Grafana linked-span navigation
}

func (d *Datasource) runQuery(ctx context.Context, q backend.DataQuery) backend.DataResponse {
	tr := q.TimeRange
	if d.baseURL == "" {
		return backend.ErrDataResponse(backend.StatusBadRequest, "Base URL is not configured — open datasource settings and select a region.")
	}

	var qm queryModel
	if err := json.Unmarshal(q.JSON, &qm); err != nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, fmt.Sprintf("invalid query JSON: %v", err))
	}

	userQuery := strings.TrimSpace(qm.Text)
	startTime := tr.From
	endTime := tr.To

	// Trace ID navigation: Grafana passes the traceID in query.Query.
	// Widen the window to ±12 h so the trace is always in range.
	if qm.Query != "" && traceIDRe.MatchString(strings.TrimSpace(qm.Query)) {
		userQuery = fmt.Sprintf("source spans | filter $d.traceID == '%s'", strings.TrimSpace(qm.Query))
		now := time.Now()
		startTime = now.Add(-12 * time.Hour)
		endTime = now
	}

	// Append a default limit when the user's query doesn't include one.
	if !limitRe.MatchString(userQuery) {
		if userQuery != "" {
			userQuery = fmt.Sprintf("%s | limit %d", userQuery, defaultLimit)
		} else {
			userQuery = fmt.Sprintf("source logs | limit %d", defaultLimit)
		}
	}

	body := map[string]any{
		"query": userQuery,
		"metadata": map[string]any{
			"tier":          "TIER_ARCHIVE",
			"syntax":        "QUERY_SYNTAX_DATAPRIME",
			"startDate":     startTime.UTC().Format(time.RFC3339Nano),
			"endDate":       endTime.UTC().Format(time.RFC3339Nano),
			"defaultSource": "logs",
		},
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusInternal, "failed to marshal request body")
	}

	apiURL := d.baseURL + "/api/v1/dataprime/query"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return backend.ErrDataResponse(backend.StatusInternal, fmt.Sprintf("failed to create request: %v", err))
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+d.apiKey)

	resp, err := d.httpClient.Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			// Request was cancelled — return an empty response rather than an error
			// so Grafana doesn't surface a spurious alert state change.
			return backend.DataResponse{}
		}
		return backend.ErrDataResponse(backend.StatusInternal, fmt.Sprintf("request failed: %v", err))
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		log.DefaultLogger.Warn("DataPrime API error", "status", resp.StatusCode, "body", string(body))
		return backend.ErrDataResponse(httpStatusToGrafana(resp.StatusCode), httpStatusMessage(resp.StatusCode))
	}

	rows, err := parseNDJSON(resp.Body)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusInternal, fmt.Sprintf("parsing response: %v", err))
	}

	frames, err := buildFrames(rows, userQuery, endTime)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusInternal, fmt.Sprintf("building frames: %v", err))
	}

	return backend.DataResponse{Frames: frames}
}

// CheckHealth is called when the user clicks "Save & test" in the datasource configuration.
func (d *Datasource) CheckHealth(ctx context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	fail := func(msg string) (*backend.CheckHealthResult, error) {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: msg}, nil
	}

	if d.baseURL == "" {
		return fail("Base URL is not configured — open datasource settings and select a region.")
	}
	if d.apiKey == "" {
		return fail("API key is not configured.")
	}

	body := map[string]any{
		"query": "source logs | limit 1",
		"metadata": map[string]any{
			"tier":          "TIER_ARCHIVE",
			"syntax":        "QUERY_SYNTAX_DATAPRIME",
			"startDate":     time.Now().Add(-60 * time.Second).UTC().Format(time.RFC3339Nano),
			"endDate":       time.Now().UTC().Format(time.RFC3339Nano),
			"defaultSource": "logs",
		},
	}
	bodyBytes, _ := json.Marshal(body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.baseURL+"/api/v1/dataprime/query", bytes.NewReader(bodyBytes))
	if err != nil {
		return fail(err.Error())
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+d.apiKey)

	resp, err := d.httpClient.Do(req)
	if err != nil {
		return fail(fmt.Sprintf("connection failed: %v", err))
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fail(httpStatusMessage(resp.StatusCode))
	}

	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: "Data source connected successfully.",
	}, nil
}

// ---------------------------------------------------------------------------
// NDJSON parsing
// ---------------------------------------------------------------------------

// dataPrimeRow is a single result row as returned by the DataPrime streaming API.
// The API response is NDJSON; each line is one of:
//
//	{"result":{"results":[{...}]}}              – envelope format
//	{"response":{"results":{"results":[{...}]}}} – alternate envelope
//	{<row fields>}                               – bare row (aggregations)
type dataPrimeRow map[string]any

type ndEnvelope struct {
	Result *struct {
		Results []dataPrimeRow `json:"results"`
	} `json:"result"`
	Response *struct {
		Results *struct {
			Results []dataPrimeRow `json:"results"`
		} `json:"results"`
	} `json:"response"`
}

// parseNDJSON reads the response body line by line, collecting all result rows.
func parseNDJSON(r io.Reader) ([]dataPrimeRow, error) {
	var rows []dataPrimeRow
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1024*1024), 4*1024*1024) // 4 MiB max line

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "{") {
			continue
		}

		// Try envelope formats first.
		var env ndEnvelope
		if err := json.Unmarshal([]byte(line), &env); err == nil {
			if env.Result != nil && len(env.Result.Results) > 0 {
				rows = append(rows, env.Result.Results...)
				continue
			}
			if env.Response != nil && env.Response.Results != nil && len(env.Response.Results.Results) > 0 {
				rows = append(rows, env.Response.Results.Results...)
				continue
			}
		}

		// Fall back to treating the line itself as a result row.
		var row dataPrimeRow
		if err := json.Unmarshal([]byte(line), &row); err == nil {
			rows = append(rows, row)
		}
	}

	return rows, scanner.Err()
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

func httpStatusToGrafana(code int) backend.Status {
	switch code {
	case http.StatusBadRequest:
		return backend.StatusBadRequest
	case http.StatusUnauthorized:
		return backend.StatusUnauthorized
	case http.StatusForbidden:
		return backend.StatusForbidden
	case http.StatusTooManyRequests:
		return backend.StatusTooManyRequests
	default:
		return backend.StatusInternal
	}
}

func httpStatusMessage(code int) string {
	switch code {
	case http.StatusUnauthorized:
		return "Authentication failed — check your API key in the datasource settings."
	case http.StatusForbidden:
		return "Permission denied — your API key may not have access to this data."
	case http.StatusTooManyRequests:
		return "Rate limited — reduce query frequency or narrow the time range."
	case http.StatusGatewayTimeout:
		return "Gateway timeout — try narrowing the time range or adding a limit clause."
	default:
		return fmt.Sprintf("DataPrime API error %d.", code)
	}
}
