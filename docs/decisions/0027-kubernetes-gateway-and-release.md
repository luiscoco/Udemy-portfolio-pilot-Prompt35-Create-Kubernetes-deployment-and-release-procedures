# 0027. Kubernetes manifests, AKS gateway and the release procedure

- Status: Accepted
- Date: 2026-10-04
- Milestone: 35

## Context

Milestone 35 must run the milestone-33 images on the milestone-34 AKS design: five workloads (web,
API, ingestion, outbox dispatcher, agent worker), one public HTTPS origin, long-lived SSE, a database
migration that runs before the application changes, and independent scaling. Nothing may be released
without separate authorization.

Facts verified on 2026-10-04:

- **Ingress lifecycle on AKS.**
  - The community Ingress-NGINX project ended maintenance in March 2026.
  - AKS supports the application routing add-on's **managed NGINX** (Ingress API) with critical
    security patches only, through **November 2026**. After that, it gets no Azure support.
  - The add-on's **Gateway API implementation** has been GA since AKS release v20260428.
    - GatewayClass: `approuting-istio`.
    - Runtime: a meshless Istio control plane in `aks-istio-system`.
    - Each Gateway gets managed Envoy proxies with their own HPA (2–5) and PDB (minAvailable 1).
    - Upgrades are in place with AKS.
    - Enabling it needs Azure CLI ≥ 2.86 and the Managed Gateway API CRDs
      (`az aks update --enable-gateway-api --enable-app-routing-istio`).
  - Limitations: no request size limits, rate limits or `EnvoyFilter`; and it cannot run together
    with the Istio service-mesh add-on.
  - Sources: [app routing Gateway API](https://learn.microsoft.com/azure/aks/app-routing-gateway-api)
    (updated 2026-09-18), [manual TLS](https://learn.microsoft.com/azure/aks/app-routing-gateway-api-tls),
    [Ingress-NGINX update](https://blog.aks.azure.com/2025/11/13/ingress-nginx-update).
- **Managed Gateway API bundle.** AKS 1.35 installs the Gateway API **v1.4.1 standard channel**.
  - Experimental CRDs are refused. That rules out HTTPRoute `retry` and session persistence.
  - `timeouts.request` is standard. A value of `0s` disables the route timeout.
  - Source: [managed Gateway API](https://learn.microsoft.com/azure/aks/managed-gateway-api).
- **Istio version on AKS 1.35.** The newest Istio minor compatible with AKS 1.35 is 1.30
  (`asm-1-30`, July 2026). Source: [support policy](https://learn.microsoft.com/azure/aks/istio-support-policy).
- **Application Gateway for Containers** supports SSE with a RoutePolicy timeout. It is billed per
  gateway and capacity unit, and drops connections not drained within 5 minutes when it scales in.
- `az aks get-versions --location eastus2` (read-only, 2026-10-04) offers 1.35.2–1.35.8 and 1.36.x.

## Decision

1. **Kustomize, not Helm.**
   - `deploy/kubernetes/` has an environment-neutral `base` (the five workloads), a `gateway`, and a
     `migrate` unit.
   - Shared `policies` and a `components/aks-platform` component (namespace plus egress) are reused by
     several units.
   - Overlays: `aks` + `aks-migrate`, and the local `local-data` + `local-migrate` + `local`.
   - All AKS values come from one non-secret `release.env` through Kustomize `replacements`.
   - Rendering needs only `kubectl`; there is no template language and no chart repository.
2. **Gateway: the AKS application routing add-on's Gateway API implementation (`approuting-istio`).**
   - One Gateway with an HTTPS listener on 443 and an HTTP listener on 80. Port 80 only issues a
     301 redirect.
   - One HTTPRoute, with rules in this order:
     - `/api/events` (Exact) → API, `timeouts.request: 0s`;
     - `/api` (PathPrefix) → API, 120 s;
     - `/` → web, 30 s.
   - The same security headers that nginx adds are set with `ResponseHeaderModifier`.
   - TLS: a PEM certificate and key in Key Vault. The Gateway needs a Kubernetes TLS Secret, so a
     dedicated `tls-sync` pod syncs them with its own new identity (`id-pp-dev-tls`). The add-on's
     shared node identity is not used.
3. **SSE does not depend on stickiness.**
   - Any API replica serves any stream. Each replica reads Redis Streams independently (ADR 0008).
   - After a drain, scale-in or proxy restart, the browser resumes from its signed `Last-Event-ID`
     cursor.
   - Liveness comes from the API's 15 s heartbeat. That is below Envoy's 5-minute stream idle timeout
     and the Azure Load Balancer's 4-minute TCP idle timeout.
   - Envoy does not buffer responses (no buffer filter is configured).
4. **Migrations are a release step, never a pod start step.**
   - A one-off Job `db-migrate-<RELEASE_ID>` runs `prisma migrate deploy` as `pp_migrator` (password
     role; the URL is read from a Key Vault file into the process only).
   - Settings: `backoffLimit: 0`, a 15-minute deadline, and pod/log retention for 7 days.
   - The release applies the application only after the Job is `Complete`. A failed Job stops the
     release with the application unchanged.
   - Schema changes follow expand/contract, and application rollback never undoes a migration
     ([database-releases.md](../kubernetes/database-releases.md)).
5. **Secrets as files, not Kubernetes Secrets.**
   - Each workload's SecretProviderClass authenticates with that workload's own identity and mounts
     files named after environment variables.
   - The container command exports them and `exec`s node, with tini still PID 1.
   - Only the gateway certificate becomes a Kubernetes Secret.
6. **Scaling.**
   - API: an HPA (2–4) on CPU 70% and memory 80%, scaling down by one pod every 5 minutes.
   - Workers: fixed replicas (ingestion 1, outbox 1, agent 1) under a documented manual policy driven
     by the queue depth and age the agent worker already reports (`operations.snapshot`,
     `pp.queue.age`).
   - CPU is explicitly not the SSE signal ([scaling.md](../kubernetes/scaling.md)).
7. **Disruption.**
   - Rolling updates use `maxUnavailable: 0`.
   - preStop is 5 s on serving pods. Termination grace exceeds every drain deadline: API 35 s,
     ingestion/outbox 35 s, agent 115 s for a 100 s drain.
   - PDBs: minAvailable 1 for web and API. maxUnavailable 1 for single-replica workers, so they never
     block a node drain.
8. **Pod Security.**
   - Every application pod meets `restricted`, checked statically and by admission warnings locally.
   - The namespace enforces `baseline`, because the add-on-managed gateway proxies run there with a
     template we do not control. `warn`/`audit` are `restricted`.
9. **AKS minor pinned to 1.35.** `kubernetesVersion = '1.35'` sets the Gateway API bundle and Istio
   minor that were tested locally.

## Alternatives considered

- **Helm chart.** It adds templating, a second toolchain and chart versioning. Five workloads with one
  parameter file fit Kustomize. A chart remains possible later if several environments diverge.
- **Application routing managed NGINX (Ingress API).** It is retiring (critical patches only until
  November 2026), so a new deployment should not start on it.
- **Application Gateway for Containers.** It is supported and handles SSE, but adds an always-on
  charge and an ALB controller with its own identity. Its scale-in drops connections after 5 minutes.
  It is worth reconsidering for WAF or multi-cluster needs.
- **Istio service-mesh add-on with Gateway API.** That is a full mesh for ingress only, needs canary
  minor upgrades, and conflicts with the app-routing implementation. Use it only if `EnvoyFilter`
  features (rate limits, body limits) become necessary.
- **Routing all traffic through the web pod's nginx.** That is one more hop and one more drain to
  coordinate. The gateway would also see only nginx, not the API's readiness. Gateway-direct routing
  lets the API's own readiness and drain decide.
- **Migrations in an init container or at API start.** Every replica would race, a crash loop would
  retry a half-applied migration, and a rollback would rerun it. Rejected.
- **CSI `secretObjects` for every workload (env from a Kubernetes Secret).** That copies every
  provider key into etcd. Files keep them in the CSI tmpfs. Rotation still needs a restart either way.
- **KEDA queue scaling now.** It needs another identity with database read access, plus a scaler
  query to maintain. The manual thresholds come first; the measured signals make KEDA a later,
  evidence-based step.
- **Sticky sessions for SSE.** They hide, rather than solve, event delivery across replicas. Drains,
  scale-ins and proxy restarts still move clients. Replay from cursors is the mechanism.

## Consequences

- One `kubectl kustomize` render per unit, validated statically by `npm run validate:k8s` (policy,
  identity cross-checks, routing, and each workload's environment run through the app's own config
  schema) and end to end on kind with upstream Istio by `npm run verify:k8s-local`.
- The release is `scripts/k8s-release.mjs`. The same `releaseToCluster` code runs locally and in the
  GitHub `production` environment.
- **Not verified on AKS:**
  - the managed gateway (annotations, its pod security posture under `baseline`);
  - CSI workload identity mounts;
  - Cilium enforcement of the same policies;
  - Azure LB health probes.

  Upstream Istio 1.30.5 on kind stands in for `approuting-istio`, and kindnet for Cilium.
- New provisioning steps: enable the add-on (`az aks update`, CLI ≥ 2.86), upload the TLS PEMs, grant
  per-secret access for the TLS identity, and grant the Anthropic key to the API and outbox
  identities. The shared article analysis is a model call in those processes too, which the
  milestone-34 matrix missed.
- **If this is wrong:**
  - SSE streams ending every 5 minutes would mean an idle timeout we did not account for (check
    Envoy access logs for `UT`/`SI`).
  - 502/503 responses without `x-portfolio-pilot-not-processed` during rollouts would mean endpoint
    propagation is slower than the 5 s preStop.

## References

- AKS application routing Gateway API: https://learn.microsoft.com/azure/aks/app-routing-gateway-api (2026-09-18)
- Manual TLS for the app routing Gateway API: https://learn.microsoft.com/azure/aks/app-routing-gateway-api-tls (2026-07-14)
- Managed Gateway API installation: https://learn.microsoft.com/azure/aks/managed-gateway-api (2026-09-10)
- Istio add-on support calendar: https://learn.microsoft.com/azure/aks/istio-support-policy (2026-09-11)
- AKS Ingress-NGINX update: https://blog.aks.azure.com/2025/11/13/ingress-nginx-update
- Gateway API v1.4.1 standard CRDs (HTTPRoute `timeouts`): https://github.com/kubernetes-sigs/gateway-api/releases/tag/v1.4.1
- Application Gateway for Containers and SSE: https://learn.microsoft.com/azure/application-gateway/for-containers/server-sent-events
