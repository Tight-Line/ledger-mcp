{{- define "ledger-mcp.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ledger-mcp.labels" -}}
app.kubernetes.io/name: ledger-mcp
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ include "ledger-mcp.tag" . | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ledger-mcp.tag" -}}
{{- .Values.image.tag | default .Chart.AppVersion -}}
{{- end -}}

{{- define "ledger-mcp.selector" -}}
app.kubernetes.io/name: ledger-mcp
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ledger-mcp.host" -}}
{{- $u := required "publicUrl is required" .Values.publicUrl | urlParse -}}
{{- $u.host -}}
{{- end -}}
