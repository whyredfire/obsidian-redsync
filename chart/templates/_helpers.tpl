{{- define "red-sync.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Uses the release name alone when it already contains the chart name
*/}}
{{- define "red-sync.fullname" -}}
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

{{- define "red-sync.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "red-sync.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "red-sync.selectorLabels" -}}
app.kubernetes.io/name: {{ include "red-sync.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Image reference from {repository, tag}, defaulting the tag to the app version
*/}}
{{- define "red-sync.image" -}}
{{- printf "%s:%s" .image.repository (.image.tag | default .context.Chart.AppVersion) }}
{{- end }}

{{- define "red-sync.r2SecretName" -}}
{{- .Values.r2.existingSecret | default (printf "%s-r2" (include "red-sync.fullname" .)) }}
{{- end }}

{{- define "red-sync.pvcName" -}}
{{- .Values.persistence.existingClaim | default (include "red-sync.fullname" .) }}
{{- end }}

{{/*
The image has no user of its own, so the chart picks one; fsGroup makes the volume writable for it
*/}}
{{- define "red-sync.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
fsGroup: 65532
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{- define "red-sync.securityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop:
    - ALL
{{- end }}

{{/*
Settings shared by the server, Litestream, and the restore: the R2 keys from the Secret, the rest from the ConfigMap
*/}}
{{- define "red-sync.envFrom" -}}
- configMapRef:
    name: {{ include "red-sync.fullname" . }}
- secretRef:
    name: {{ include "red-sync.r2SecretName" . }}
{{- end }}

{{/*
Egress rule for cluster DNS
*/}}
{{- define "red-sync.dnsEgress" -}}
- to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
  ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
{{- end }}

{{/*
Port of the R2 endpoint, 443 unless it names one
*/}}
{{- define "red-sync.r2Port" -}}
{{- $url := urlParse .Values.r2.endpoint }}
{{- regexFind "[0-9]+$" (regexFind ":[0-9]+$" $url.host) | default (ternary "443" "80" (eq $url.scheme "https")) }}
{{- end }}
