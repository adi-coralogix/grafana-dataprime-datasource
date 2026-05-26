package plugin

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/data"
)

const nsEpochThreshold = 1e15 // values above this are nanosecond timestamps

var (
	aggQueryRe  = regexp.MustCompile(`(?i)\b(groupby|countby|count\s+by|aggregate|timeseries)\b`)
	spanQueryRe = regexp.MustCompile(`(?i)\bsource\s+spans\b`)
)

// buildFrames converts DataPrime result rows into Grafana data frames.
// The routing logic mirrors the TypeScript framify() in datasource.ts.
func buildFrames(rows []dataPrimeRow, query string, endTime time.Time) ([]*data.Frame, error) {
	if len(rows) == 0 {
		return nil, nil
	}

	isAgg := looksLikeAggregation(rows) || aggQueryRe.MatchString(query)

	switch {
	case isAgg:
		return toAggregateFrames(rows)
	case spanQueryRe.MatchString(query):
		return []*data.Frame{toTraceFrame(rows)}, nil
	default:
		return []*data.Frame{toLogsFrame(rows)}, nil
	}
}

// ---------------------------------------------------------------------------
// Aggregation detection
// ---------------------------------------------------------------------------

// looksLikeAggregation returns true when the rows have numeric-only top-level
// values (i.e. the row IS the aggregation result, not a raw log).
func looksLikeAggregation(rows []dataPrimeRow) bool {
	if len(rows) == 0 {
		return false
	}
	// Unwrap userData first — if it exists the row is definitely an agg result.
	flat := unwrapUserData(rows[0])
	for k, v := range flat {
		if strings.HasPrefix(k, "_") || k == "count" {
			_ = v
			return true
		}
	}
	return false
}

// unwrapUserData extracts the actual data fields from a DataPrime row.
// Aggregation results nest their payload inside userData (as a JSON string or
// a pre-parsed object). Raw log rows are returned as-is.
func unwrapUserData(row dataPrimeRow) map[string]any {
	if ud, ok := row["userData"]; ok && ud != nil {
		switch v := ud.(type) {
		case string:
			if strings.TrimSpace(v) != "" && v[0] == '{' {
				var obj map[string]any
				if err := json.Unmarshal([]byte(v), &obj); err == nil {
					return obj
				}
			}
		case map[string]any:
			return v
		}
	}
	return row
}

// ---------------------------------------------------------------------------
// Aggregate frames
// ---------------------------------------------------------------------------

func toAggregateFrames(rows []dataPrimeRow) ([]*data.Frame, error) {
	// Flatten all rows, unwrapping userData.
	flat := make([]map[string]any, len(rows))
	for i, r := range rows {
		flat[i] = unwrapUserData(r)
	}

	// Categorise columns: time (nanosecond epoch), numeric (metric), or dimension (string).
	allKeys := collectKeys(flat)
	var timeKey string
	var valueKeys, dimKeys []string

	for _, key := range allKeys {
		sample := firstNonNil(flat, key)
		if sample == nil {
			dimKeys = append(dimKeys, key)
			continue
		}
		if num, ok := toFloat(sample); ok {
			if num > nsEpochThreshold {
				timeKey = key
			} else {
				valueKeys = append(valueKeys, key)
			}
		} else {
			dimKeys = append(dimKeys, key)
		}
	}

	// ── Time series mode ──────────────────────────────────────────────────────
	if timeKey != "" {
		return buildTimeSeriesFrames(flat, timeKey, valueKeys, dimKeys)
	}

	// ── Wide-format pivot (single dim, single value) ──────────────────────────
	// e.g. "countby $l.applicationname" → one numeric field per category.
	// This is what makes pie/bar/stat panels work without manual transformations.
	if len(dimKeys) == 1 && len(valueKeys) == 1 {
		frame := data.NewFrame("")
		frame.Meta = &data.FrameMeta{PreferredVisualization: data.VisTypeTable}
		for _, row := range flat {
			label := fmt.Sprintf("%v", row[dimKeys[0]])
			val := toFloatOrZero(row[valueKeys[0]])
			v := val
			frame.Fields = append(frame.Fields,
				data.NewField(label, nil, []*float64{&v}),
			)
		}
		return []*data.Frame{frame}, nil
	}

	// ── Table (multi-dim or multi-value) ──────────────────────────────────────
	frame := data.NewFrame("")
	frame.Meta = &data.FrameMeta{PreferredVisualization: data.VisTypeTable}
	for _, key := range dimKeys {
		vals := make([]*string, len(flat))
		for i, row := range flat {
			s := fmt.Sprintf("%v", row[key])
			vals[i] = &s
		}
		frame.Fields = append(frame.Fields, data.NewField(key, nil, vals))
	}
	for _, key := range valueKeys {
		vals := make([]*float64, len(flat))
		for i, row := range flat {
			v := toFloatOrZero(row[key])
			vals[i] = &v
		}
		frame.Fields = append(frame.Fields, data.NewField(key, nil, vals))
	}
	return []*data.Frame{frame}, nil
}

// buildTimeSeriesFrames groups rows by their dimension labels and returns one
// frame per (metric × label-set) combination — the standard Grafana wide format
// for time series visualizations.
func buildTimeSeriesFrames(
	flat []map[string]any,
	timeKey string,
	valueKeys, dimKeys []string,
) ([]*data.Frame, error) {
	type group struct {
		labels data.Labels
		times  []time.Time
		vals   map[string][]float64
	}
	groups := make(map[string]*group)
	var order []string // preserve first-seen order

	for _, row := range flat {
		labels := make(data.Labels, len(dimKeys))
		for _, k := range dimKeys {
			labels[k] = fmt.Sprintf("%v", row[k])
		}
		key := labels.String()

		if _, exists := groups[key]; !exists {
			vals := make(map[string][]float64, len(valueKeys))
			for _, vk := range valueKeys {
				vals[vk] = nil
			}
			groups[key] = &group{labels: labels, vals: vals}
			order = append(order, key)
		}
		g := groups[key]

		nsVal := toFloatOrZero(row[timeKey])
		ms := int64(nsVal) / 1_000_000
		g.times = append(g.times, time.UnixMilli(ms))

		for _, vk := range valueKeys {
			g.vals[vk] = append(g.vals[vk], toFloatOrZero(row[vk]))
		}
	}

	var frames []*data.Frame
	for _, key := range order {
		g := groups[key]
		for _, vk := range valueKeys {
			frame := data.NewFrame("")
			frame.Meta = &data.FrameMeta{PreferredVisualization: data.VisTypeGraph}

			timeField := data.NewField("time", nil, g.times)
			valField := data.NewField(vk, g.labels, g.vals[vk])
			frame.Fields = append(frame.Fields, timeField, valField)
			frames = append(frames, frame)
		}
	}
	return frames, nil
}

// ---------------------------------------------------------------------------
// Log frame
// ---------------------------------------------------------------------------

func toLogsFrame(rows []dataPrimeRow) *data.Frame {
	n := len(rows)

	times := make([]*time.Time, n)
	lines := make([]*string, n)
	severities := make([]*string, n)
	appNames := make([]*string, n)
	subsystems := make([]*string, n)
	bodies := make([]*string, n)
	traceIDs := make([]*string, n)
	spanIDs := make([]*string, n)
	pods := make([]*string, n)

	// Collect all userData objects so we can discover d.* keys afterwards.
	userObjs := make([]map[string]any, n)

	for i, row := range rows {
		// Timestamp
		if ts := nestedStr(row, "metadata", "timestamp"); ts != "" {
			if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
				times[i] = &t
			}
		}
		if times[i] == nil {
			now := time.Now()
			times[i] = &now
		}

		// Severity
		if s := nestedStr(row, "metadata", "severity"); s != "" {
			severities[i] = &s
		}

		// Labels
		if l := labelMap(row); len(l) > 0 {
			an := l["applicationname"]
			appNames[i] = &an
			ss := l["subsystemname"]
			subsystems[i] = &ss
			p := l["pod"]
			pods[i] = &p
		}

		// userData
		var userObj map[string]any
		if ud, ok := row["userData"]; ok && ud != nil {
			switch v := ud.(type) {
			case string:
				_ = json.Unmarshal([]byte(v), &userObj)
			case map[string]any:
				userObj = v
			}
		}
		if userObj == nil {
			userObj = map[string]any{}
		}
		userObjs[i] = userObj

		// Build the display line from userData
		lineBytes, _ := json.Marshal(userObj)
		lineStr := string(lineBytes)
		lines[i] = &lineStr

		// Well-known userData fields
		body := strFromObj(userObj, "body", "message", "msg")
		bodies[i] = &body

		tid := strFromObj(userObj, "traceId", "trace_id")
		traceIDs[i] = &tid

		sid := strFromObj(userObj, "spanId", "span_id")
		spanIDs[i] = &sid
	}

	frame := data.NewFrame("logs")
	frame.Meta = &data.FrameMeta{PreferredVisualization: data.VisTypeLogs}

	frame.Fields = append(frame.Fields,
		data.NewField("time", nil, times),
		withConfig(data.NewField("line", nil, lines), &data.FieldConfig{DisplayNameFromDS: "line"}),
		data.NewField("severity", nil, severities),
		data.NewField("applicationname", nil, appNames),
		data.NewField("subsystemname", nil, subsystems),
		data.NewField("body", nil, bodies),
		data.NewField("traceId", nil, traceIDs),
		data.NewField("spanId", nil, spanIDs),
		data.NewField("pod", nil, pods),
	)

	// Discover d.* keys sorted by frequency.
	keyFreq := make(map[string]int)
	for _, obj := range userObjs {
		for k := range obj {
			keyFreq[k]++
		}
	}
	type kf struct{ k string; f int }
	ranked := make([]kf, 0, len(keyFreq))
	for k, f := range keyFreq {
		ranked = append(ranked, kf{k, f})
	}
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].f != ranked[j].f {
			return ranked[i].f > ranked[j].f
		}
		return ranked[i].k < ranked[j].k
	})

	for _, kv := range ranked {
		vals := make([]*string, n)
		for i, obj := range userObjs {
			if v, ok := obj[kv.k]; ok && v != nil {
				var s string
				switch tv := v.(type) {
				case string:
					s = tv
				default:
					b, _ := json.Marshal(tv)
					s = string(b)
				}
				vals[i] = &s
			}
		}
		frame.Fields = append(frame.Fields, data.NewField("d."+kv.k, nil, vals))
	}

	return frame
}

// ---------------------------------------------------------------------------
// Trace frame (Jaeger-compatible)
// ---------------------------------------------------------------------------

func toTraceFrame(rows []dataPrimeRow) *data.Frame {
	// Grafana's native trace panel expects fields defined in
	// https://grafana.com/docs/grafana/latest/explore/trace-integration/
	n := len(rows)

	traceIDs := make([]*string, n)
	spanIDs := make([]*string, n)
	parentSpanIDs := make([]*string, n)
	serviceNames := make([]*string, n)
	operationNames := make([]*string, n)
	startTimes := make([]*float64, n)
	durations := make([]*float64, n)

	for i, row := range rows {
		var ud map[string]any
		if raw, ok := row["userData"]; ok {
			switch v := raw.(type) {
			case string:
				_ = json.Unmarshal([]byte(v), &ud)
			case map[string]any:
				ud = v
			}
		}
		if ud == nil {
			ud = row
		}

		tid := stringVal(ud, "traceID", "traceId")
		traceIDs[i] = &tid

		sid := stringVal(ud, "spanID", "spanId")
		spanIDs[i] = &sid

		pid := stringVal(ud, "parentId", "parentSpanId")
		parentSpanIDs[i] = &pid

		op := stringVal(ud, "operationName")
		operationNames[i] = &op

		svc := ""
		if p, ok := ud["process"].(map[string]any); ok {
			svc = fmt.Sprintf("%v", p["serviceName"])
		}
		serviceNames[i] = &svc

		st := toFloatOrZero(ud["startTime"])
		startTimes[i] = &st

		dur := toFloatOrZero(ud["duration"])
		durations[i] = &dur
	}

	frame := data.NewFrame("traces")
	frame.Meta = &data.FrameMeta{PreferredVisualization: data.VisTypeTrace}
	frame.Fields = append(frame.Fields,
		data.NewField("traceID", nil, traceIDs),
		data.NewField("spanID", nil, spanIDs),
		data.NewField("parentSpanID", nil, parentSpanIDs),
		data.NewField("operationName", nil, operationNames),
		data.NewField("serviceName", nil, serviceNames),
		data.NewField("startTime", nil, startTimes),
		data.NewField("duration", nil, durations),
	)
	return frame
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func collectKeys(rows []map[string]any) []string {
	seen := make(map[string]struct{})
	var keys []string
	for _, row := range rows {
		for k := range row {
			if _, ok := seen[k]; !ok {
				seen[k] = struct{}{}
				keys = append(keys, k)
			}
		}
	}
	sort.Strings(keys)
	return keys
}

func firstNonNil(rows []map[string]any, key string) any {
	for _, row := range rows {
		if v, ok := row[key]; ok && v != nil {
			return v
		}
	}
	return nil
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

func toFloatOrZero(v any) float64 {
	f, _ := toFloat(v)
	return f
}

func stringVal(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return fmt.Sprintf("%v", v)
		}
	}
	return ""
}

func strFromObj(obj map[string]any, keys ...string) string {
	return stringVal(obj, keys...)
}

func nestedStr(row dataPrimeRow, keys ...string) string {
	var cur any = map[string]any(row)
	for _, k := range keys {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur = m[k]
	}
	if cur == nil {
		return ""
	}
	return fmt.Sprintf("%v", cur)
}

func labelMap(row dataPrimeRow) map[string]string {
	result := make(map[string]string)
	labels, ok := row["labels"]
	if !ok {
		return result
	}
	switch v := labels.(type) {
	case []any:
		for _, item := range v {
			if kv, ok := item.(map[string]any); ok {
				k, _ := kv["key"].(string)
				val, _ := kv["value"].(string)
				result[strings.ToLower(k)] = val
			}
		}
	case map[string]any:
		for k, val := range v {
			result[strings.ToLower(k)] = fmt.Sprintf("%v", val)
		}
	}
	return result
}

func withConfig(f *data.Field, cfg *data.FieldConfig) *data.Field {
	f.Config = cfg
	return f
}
