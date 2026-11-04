{{/* Chart name. */}}
{{- define "observer-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Full name: release name, plus the chart name unless the release already contains it. */}}
{{- define "observer-agent.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "observer-agent.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "observer-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "observer-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "observer-agent.labels" -}}
helm.sh/chart: {{ include "observer-agent.chart" . }}
{{ include "observer-agent.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{- define "observer-agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "observer-agent.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Image reference: the digest wins over the tag; the tag defaults to appVersion. */}}
{{- define "observer-agent.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}
{{- end }}

{{/* Secret and key the agent key is read from. */}}
{{- define "observer-agent.keySecretName" -}}
{{- if .Values.agentKey }}{{ include "observer-agent.fullname" . }}{{ else }}{{ .Values.existingSecret.name }}{{ end }}
{{- end }}
{{- define "observer-agent.keySecretKey" -}}
{{- if .Values.agentKey }}AGENT_KEY{{ else }}{{ .Values.existingSecret.key }}{{ end }}
{{- end }}

{{/*
Health probe: AGENT_RUNTIME.healthExec (packages/protocol agent-runtime.ts),
verbatim. The image is distroless and the dashboard binds loopback, so the
probe runs the image's own Bun against /healthz. tests/chart-version.test.ts
checks this line against the contract.
*/}}
{{- define "observer-agent.healthExec" -}}
["/usr/local/bin/bun","-e","fetch('http://127.0.0.1:10101/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
{{- end }}
