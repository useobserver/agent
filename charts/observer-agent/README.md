# observer-agent

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 1.7.3](https://img.shields.io/badge/AppVersion-1.7.3-informational?style=flat-square)

Observer Agent. Runs your checks inside your network and sends the results to Observer.

**Homepage:** <https://use.observer>

## Install

Create the agent in Observer (Agents, Add agent) and copy its key. Then:

```sh
kubectl create namespace observability
kubectl create secret generic observer-agent -n observability --from-literal=AGENT_KEY='obs_live_...'
helm install observer-agent oci://ghcr.io/useobserver/charts/observer-agent \
  -n observability --set existingSecret.name=observer-agent
```

One agent key = one release. The chart always runs one replica.

The agent keeps results it could not send yet in a local queue on a
PersistentVolumeClaim at `/data`. Set `persistence.enabled=false` on clusters
without a storage class; the queue is then lost when the pod restarts.

## Probe secrets

Checks reference secrets by environment variable name (`connection_string_ref`,
`token_ref`, `header_refs`, ...). Put them in a Secret and pass it with `envFrom`:

```yaml
envFrom:
  - secretRef:
      name: observer-probe-secrets
```

## Cloud workload identity

The agent uses the cloud SDK's default credential chain. Annotate the
ServiceAccount:

| Cloud | Values |
|-------|--------|
| EKS (IRSA) | `serviceAccount.annotations."eks\.amazonaws\.com/role-arn"` |
| GKE | `serviceAccount.annotations."iam\.gke\.io/gcp-service-account"` |
| AKS | `serviceAccount.annotations."azure\.workload\.identity/client-id"` and `podLabels."azure\.workload\.identity/use"="true"` |

## Requirements

Kubernetes: `>=1.29.0-0`

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| affinity | object | `{}` | Affinity. |
| agentKey | string | `""` | The agent key (obs_live_...). The chart stores it in a Secret it creates. Set exactly one of agentKey or existingSecret.name. Avoid this in GitOps repos: use existingSecret instead. |
| broadcastLogs | bool | `false` | Send agent logs to Observer (BROADCAST_LOGS). |
| bufferMaxRows | string | `""` | Maximum rows in the local queue (BUFFER_MAX_ROWS). Empty: the agent default. |
| caBundle.configMap | string | `""` | ConfigMap with a private CA bundle. Mounted read-only; sets NODE_EXTRA_CA_CERTS. |
| caBundle.key | string | `"ca.crt"` | Key in the ConfigMap that holds the PEM bundle. |
| cloudUrl | string | `"https://use.observer"` | Observer URL the agent reports to (CLOUD_SERVER_URL). |
| commonLabels | object | `{}` | Labels added to every resource. |
| envFrom | list | `[]` | Extra env sources, for probe secrets referenced by *_ref fields (connection_string_ref, token_ref, header_refs, ...). Example: [{ secretRef: { name: observer-probe-secrets } }] |
| existingSecret.key | string | `"AGENT_KEY"` | Key inside that Secret. |
| existingSecret.name | string | `""` | Name of an existing Secret that holds the agent key. |
| extraEnv | list | `[]` | Extra environment variables (EnvVar list; valueFrom allowed). |
| extraVolumeMounts | list | `[]` | Extra volume mounts for the agent container. |
| extraVolumes | list | `[]` | Extra volumes, for example a Secret with PEM files for *_cert_ref fields. |
| fullnameOverride | string | `""` | Override the full resource name. |
| heartbeatRelay.enabled | bool | `false` | Accept heartbeat pings from jobs in the cluster and relay them (HEARTBEAT_RELAY_ENABLED). Binds 0.0.0.0 in the pod and adds a Service. |
| heartbeatRelay.port | int | `10102` | Relay port. |
| heartbeatRelay.service.annotations | object | `{}` | Service annotations for the relay. |
| heartbeatRelay.service.type | string | `"ClusterIP"` | Service type for the relay. |
| image.digest | string | `""` | Image digest (sha256:...). When set it wins over the tag. |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| image.repository | string | `"ghcr.io/useobserver/agent"` | Agent image repository. |
| image.tag | string | `""` | Image tag. Empty uses the chart's appVersion. |
| imagePullSecrets | list | `[]` | Pull secrets for a private mirror of the image. |
| livenessProbe | object | `{"initialDelaySeconds":15,"periodSeconds":30,"timeoutSeconds":5,"failureThreshold":3}` | Liveness probe timings. The probe runs the image's own Bun against /healthz. |
| logLevel | string | `"WARN"` | Lowest log level sent to Observer when broadcastLogs is on (LOG_BROADCAST_LEVEL). |
| nameOverride | string | `""` | Override the chart name in resource names. |
| networkPolicy.enabled | bool | `false` | Create a NetworkPolicy. Egress: DNS, TCP 443 anywhere, plus extraEgress. Ingress: only the relay and OTLP ports, when enabled. |
| networkPolicy.extraEgress | list | `[]` | Extra egress rules (NetworkPolicyEgressRule list), for example Prometheus or a database on another port. |
| nodeSelector | object | `{}` | Node selector. |
| otlp.enabled | bool | `false` | Accept OpenTelemetry metrics over OTLP/HTTP from other pods. Binds 0.0.0.0:<port> and adds a Service. Requires tokenSecret. |
| otlp.port | int | `4318` | OTLP/HTTP port. |
| otlp.service.annotations | object | `{}` | Service annotations for the OTLP receiver. |
| otlp.service.type | string | `"ClusterIP"` | Service type for the OTLP receiver. |
| otlp.tokenSecret | object | `{"name":"","key":"token"}` | Secret holding the bearer token senders must present (OBSERVER_OTLP_BEARER_TOKEN). |
| persistence.accessModes | list | `["ReadWriteOnce"]` | Access modes of the claim. |
| persistence.enabled | bool | `true` | Keep the local queue on a PersistentVolumeClaim at /data. false: emptyDir (queued results are lost on restart). |
| persistence.existingClaim | string | `""` | Use an existing claim instead of creating one. |
| persistence.size | string | `"1Gi"` | Size of the claim. |
| persistence.storageClass | string | `""` | Storage class. Empty: the cluster default. |
| podAnnotations | object | `{}` | Extra pod annotations. |
| podLabels | object | `{}` | Extra pod labels. Azure workload identity needs azure.workload.identity/use: "true". |
| podSecurityContext | object | `{"runAsNonRoot":true,"runAsUser":65532,"runAsGroup":65532,"fsGroup":65532,"seccompProfile":{"type":"RuntimeDefault"}}` | Pod security context. |
| priorityClassName | string | `""` | Pod priority class. |
| prometheus.basicAuth.enabled | bool | `false` | Use basic auth against Prometheus (PROMETHEUS_BASIC_AUTH_ENABLED). |
| prometheus.basicAuth.passwordSecret | object | `{"name":"","key":"password"}` | Secret holding the basic auth password (PROMETHEUS_PASSWORD). |
| prometheus.basicAuth.username | string | `""` | Basic auth user name. |
| prometheus.bearerTokenSecret | object | `{"name":"","key":"token"}` | Secret holding a bearer token for Prometheus (PROMETHEUS_BEARER_TOKEN). Not together with basic auth. |
| prometheus.headersSecret | object | `{"name":"","key":"headers"}` | Secret holding extra request headers as JSON (PROMETHEUS_HEADERS). |
| prometheus.tenantId | string | `""` | Tenant id sent as X-Scope-OrgID, for Mimir, Cortex or Thanos (PROMETHEUS_TENANT_ID). |
| prometheus.url | string | `""` | Prometheus base URL for prometheus metrics (PROMETHEUS_SERVER_URL). Empty: no Prometheus. |
| proxy.http | string | `""` | HTTP_PROXY for outbound calls. |
| proxy.https | string | `""` | HTTPS_PROXY for outbound calls. |
| proxy.noProxy | string | `""` | NO_PROXY. List hostnames: cluster CIDRs are not supported by NO_PROXY. |
| readinessProbe | object | `{"initialDelaySeconds":5,"periodSeconds":15,"timeoutSeconds":5,"failureThreshold":3}` | Readiness probe timings. |
| resources | object | `{"requests":{"cpu":"50m","memory":"96Mi"},"limits":{"memory":"256Mi"}}` | Container resources. |
| securityContext | object | `{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]}}` | Container security context. |
| serviceAccount.annotations | object | `{}` | ServiceAccount annotations. Workload identity: EKS (IRSA) eks.amazonaws.com/role-arn, GKE iam.gke.io/gcp-service-account, Azure azure.workload.identity/client-id. |
| serviceAccount.automountToken | bool | `false` | Mount the Kubernetes API token. The agent does not call the Kubernetes API. |
| serviceAccount.create | bool | `true` | Create a ServiceAccount. |
| serviceAccount.name | string | `""` | ServiceAccount name. Empty: the full name when created, else "default". |
| terminationGracePeriodSeconds | int | `15` | Seconds the agent gets to flush and stop. |
| tolerations | list | `[]` | Tolerations. |
| topologySpreadConstraints | list | `[]` | Topology spread constraints. |
| verbose | bool | `false` | Verbose logs (VERBOSE). |
