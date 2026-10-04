# Gateway, SSE and network policy (milestone 35)

Decision record: [ADR 0027](../decisions/0027-kubernetes-gateway-and-release.md). Manifests:
[gateway.yaml](../../deploy/kubernetes/gateway/gateway.yaml),
[policies](../../deploy/kubernetes/policies/baseline.yaml),
[base/network-policies.yaml](../../deploy/kubernetes/base/network-policies.yaml),
[components/aks-platform](../../deploy/kubernetes/components/aks-platform/network-policies.yaml).

## One HTTPS origin

```text
browser ──HTTPS 443──▶ Azure LB ──▶ gateway proxies (Envoy, approuting-istio, 2–5 pods, PDB)
                                   ├─ /api/events (Exact)  ─▶ Service api:3001   timeout 0s (stream)
                                   ├─ /api/*   (Prefix)    ─▶ Service api:3001   timeout 120 s
                                   └─ /*                   ─▶ Service web:8080   timeout 30 s (nginx, SPA)
        ──HTTP 80──▶ 301 https://<host>/<path>
```

- **Origin and authentication.**
  - `AUTH_BASE_URL` is exactly `https://<PUBLIC_HOSTNAME>`. `validate:k8s` checks it against the
    Gateway listener.
  - Cookies are `Secure; SameSite=Lax`, and Better Auth's origin check compares against that single
    origin.
- **Headers.**
  - nginx sets the CSP, cache policy and security headers for the frontend.
  - For `/api`, the HTTPRoute sets the same headers nginx used to add in the Compose topology, plus
    HSTS on every route.
- **What the gateway cannot do here.** The add-on has no request body size limits or rate limits, and
  no `EnvoyFilter`. The API already bounds request bodies (milestone 29) and rate-limits per user in
  Redis (milestone 30), so neither depends on the proxy.
- **Client IP.** With the default `externalTrafficPolicy: Cluster`, the source address reaching Envoy
  is a node address.
  - The application's own limits are keyed by user, so this does not matter to them.
  - Better Auth's sign-in rate limit is per IP and therefore coarse. Preserving client IPs
    (`externalTrafficPolicy: Local`) needs the add-on's probe annotations changed and is left for later.

## Long-lived SSE without sticky sessions

| Layer | Setting | Why the stream survives |
| --- | --- | --- |
| API | heartbeat comment every 15 s (`SSE_LIMITS.heartbeatMs`) | keeps every idle timer below from firing |
| Envoy route | `timeouts.request: 0s` on `/api/events` only | the 120 s `/api` timeout would otherwise end every stream |
| Envoy stream idle timeout | 5 min (Envoy default) | heartbeat ≪ 5 min |
| Azure Load Balancer | TCP idle timeout 4 min (default) | heartbeat ≪ 4 min |
| NAT gateway (egress only) | 10 min | not on the inbound path |
| Buffering | no buffer filter on the gateway; nginx `proxy_buffering off` still guards the Compose path | each frame is flushed at once |

Event delivery does not rely on the connection staying on one pod:

- Every API replica reads the user's Redis Stream itself (ADR 0008). No replica owns a user.
- Each frame carries a signed cursor (`id:`). After any disconnect (drain, scale-in, gateway upgrade,
  network blip), the browser reconnects with `Last-Event-ID` to *any* replica and resumes. When the
  cursor has expired, it gets `stream.reset` and reloads its snapshot.
- Session affinity would only hide this path in testing. It would still break on every drain, and it
  makes load uneven. It is deliberately not configured.

Graceful rollouts:

- **API pod.** On termination its endpoint is removed and the 5 s `preStop` lets Envoy see that.
  Then SIGTERM makes `server.mjs`:
  - fail readiness;
  - answer new requests with `503` + `x-portfolio-pilot-not-processed` (safe to retry);
  - close its SSE streams so clients reconnect elsewhere;
  - finish in-flight requests within 20 s.

  `maxUnavailable: 0` keeps capacity during the rollout.
- **Gateway proxies.** They drain for up to 45 s (`--drain-time-s 45` in Istio's proxy) when the
  add-on upgrades or scales them. Streams then reconnect.

Verified on kind with upstream Istio 1.30.5 (`npm run verify:k8s-local`, see the
[verification report](../verification-report.md)):

- an idle stream held 330 s, with heartbeats 15 s apart;
- a rolling restart of every API pod under load with zero failed requests;
- the stream resuming on a new replica.

## NetworkPolicy (Cilium on AKS)

Every pod labelled `app.kubernetes.io/part-of: portfolio-pilot` starts from **default deny, ingress
and egress**, plus DNS to CoreDNS. Then:

| From → To | Port | Policy |
| --- | --- | --- |
| gateway proxies → web | 8080 | `web-ingress` |
| gateway proxies, web (nginx's `/api` proxy) → api | 3001 | `api-ingress`, `web-egress-api` |
| api, ingestion, outbox, agent → private-endpoint subnet | 5432, 10000, 443 | `data-services-egress` (CIDR from `release.env`) |
| api, ingestion, outbox, agent → public internet | 443 | `public-https-egress`: Entra token exchange, Anthropic, Alpaca; RFC 1918, CGNAT and link-local excluded (no IMDS) |
| db-migrate → private-endpoint subnet | 5432 | `migrate-egress` |
| tls-sync | — | nothing: the CSI driver fetches Key Vault on the node, not in the pod |
| workers ← anything | — | nothing: probes come from the kubelet |

- **Gateway proxies are not under default deny.** Istio copies Gateway labels onto them, so the Gateway
  deliberately carries no `part-of` label. Their pod template belongs to the add-on, and restricting
  them could break its health probes, xDS (istiod in `aks-istio-system`) or upgrades.
- **No host-name egress filtering.** The NAT gateway cannot filter host names
  ([network.md](../azure/network.md)). Host-level control stays in the application: fixed provider
  endpoints, no redirects.
- **Local evidence.** The local verification asserts the matrix from inside the pods on kindnet:
  - web cannot reach PostgreSQL or Redis;
  - workers cannot reach the API;
  - the agent cannot reach the internet;
  - the API can reach its data services.

  Cilium on AKS has not run these policies.
