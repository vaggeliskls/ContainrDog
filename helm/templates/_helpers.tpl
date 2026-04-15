{{/*
Expand the name of the chart.
*/}}
{{- define "containrdog.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "containrdog.fullname" -}}
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

{{/*
Chart label.
*/}}
{{- define "containrdog.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "containrdog.labels" -}}
helm.sh/chart: {{ include "containrdog.chart" . }}
{{ include "containrdog.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "containrdog.selectorLabels" -}}
app.kubernetes.io/name: {{ include "containrdog.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "containrdog.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "containrdog.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Image tag — falls back to Chart.AppVersion.
*/}}
{{- define "containrdog.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag }}
{{- end }}

{{/*
Detect whether we're rendering against an OpenShift cluster by checking for
the security.openshift.io API group (only registered on OpenShift).
*/}}
{{- define "containrdog.isOpenShift" -}}
{{- .Capabilities.APIVersions.Has "security.openshift.io/v1" -}}
{{- end }}

{{/*
Pod-level securityContext. User-provided values win; otherwise default to
fsGroup: 1000 on vanilla k8s (matches the "node" user in the image), and
leave empty on OpenShift so its SCC can auto-assign one from the namespace range.
*/}}
{{- define "containrdog.podSecurityContext" -}}
{{- if .Values.podSecurityContext -}}
{{- toYaml .Values.podSecurityContext -}}
{{- else if not (include "containrdog.isOpenShift" . | eq "true") -}}
fsGroup: 1000
{{- end -}}
{{- end }}

{{/*
Secret name for sensitive env vars.
*/}}
{{- define "containrdog.secretName" -}}
{{- if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else }}
{{- include "containrdog.fullname" . }}
{{- end }}
{{- end }}
