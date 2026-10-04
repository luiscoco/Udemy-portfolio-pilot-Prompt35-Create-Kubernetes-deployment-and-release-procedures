# Verifying the Kubernetes release locally (milestone 35)

Two commands, neither of which touches Azure:

| Command | Needs | What it proves |
| --- | --- | --- |
| `npm run validate:k8s -- --self-test` | `kubectl` (for `kubectl kustomize`), `npm run build --workspace @portfolio-pilot/config` | every overlay renders; pod, secret, identity and routing policy; each workload's environment passes the app's own config schema; 15 planted violations are detected |
| `npm run verify:k8s-local` | Docker, `kubectl`, `kind` 0.33, `istioctl` 1.30.5, `openssl`, the four `:local` images | the real release order on a 3-node Kubernetes 1.35 cluster with upstream Istio, then traffic, drain and policy tests (below) |

`npm run test:k8s` unit-tests the `release.env` generation and validation.

## Tools

`kind` and `istioctl` are looked up in `.local/tools/` (git-ignored) first, then on `PATH`:

```bash
mkdir -p .local/tools && cd .local/tools
curl -sSLo kind.exe https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-windows-amd64      # Linux: kind-linux-amd64 -> kind
curl -sSL https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-windows-amd64.sha256sum       # compare with: sha256sum kind.exe
curl -sSLo istioctl.zip https://github.com/istio/istio/releases/download/1.30.5/istioctl-1.30.5-win.zip        # Linux: istioctl-1.30.5-linux-amd64.tar.gz
curl -sSL https://github.com/istio/istio/releases/download/1.30.5/istioctl-1.30.5-win.zip.sha256
unzip -o istioctl.zip && cd ../..
docker compose -f compose.production.yaml build      # portfolio-pilot-{web,api,worker,migrate}:local
```

PowerShell users can run the same `npm` commands; download the tools with `Invoke-WebRequest`.

## What `verify:k8s-local` does

1. **Cluster.**
   - Creates kind cluster `pp-m35` ([kind-cluster.yaml](../../deploy/kubernetes/local/kind-cluster.yaml):
     Kubernetes 1.35.8 pinned by digest, two workers).
   - Installs the Gateway API **v1.4.1 standard** CRDs (what AKS 1.35 manages) and Istio 1.30.5
     `minimal`.
   - Installs the SecretProviderClass CRD, used only for the AKS dry run.
   - Side-loads the Istio, PostgreSQL, Redis and application images. kind nodes resolve registries
     through Docker's DNS, which failed intermittently during development.
2. **Data.**
   - [overlays/local-data](../../deploy/kubernetes/overlays/local-data): the namespace with the AKS
     Pod Security labels, plus throwaway PostgreSQL and Redis running unprivileged with read-only
     roots.
   - Random secrets (`local-postgres`, `local-migrate`, `local-app`) and a throwaway TLS certificate
     are created per run. Nothing secret is in the repository.
3. **Release**, with the same `releaseToCluster` function the AKS release uses:
   server-side dry run → migration Job awaited → application → rollouts → Gateway `Programmed`.
   The check then proves the Job completed before any application Deployment existed.
4. **Demo seed.** The seed refuses non-loopback databases, so it runs as an ephemeral container *in
   the PostgreSQL pod* (`kubectl debug --profile=restricted`) and connects over 127.0.0.1, like
   Compose's `network_mode: service:postgres`.
5. **Checks** through `https://localhost:8443`, a port-forward to the gateway pod. `AUTH_BASE_URL` is
   the same loopback origin, which the demo profile requires:
   - **Autoscaling.** The API autoscaler raises the Deployment, which has no `replicas` field, to 2.
   - **Pod Security.** No restricted-profile warning for any application pod.
   - **Posture, inside every pod:**
     - the UID is not 0;
     - there is no service-account token;
     - the root filesystem and the application code are read-only;
     - `/tmp` is writable.
   - **NetworkPolicy matrix** (eight flows; see [networking.md](networking.md)).
   - **Smoke test** ([scripts/k8s-smoke.mjs](../../scripts/k8s-smoke.mjs)):
     - SPA, headers and readiness;
     - HTTP → HTTPS redirect, and 401 on an anonymous stream;
     - demo sign-in, then trade → outbox → Redis → SSE;
     - an **idle stream held 330 s**, with heartbeats about 15 s apart.
   - **API rolling restart under load.**
     - Requests every 100 ms plus an open SSE stream while every API pod is replaced.
     - Zero failed requests (a 503 marked "not processed" would be counted separately).
     - The stream reconnects to a new replica with `Last-Event-ID` and receives the next event.
   - **Worker drain.**
     - All three roles are restarted while an agent run is in flight.
     - Each old pod logs `worker.draining` → `worker.drained`, and none is force-exited.
     - The run completes.
   - **Node drain.**
     - `kubectl drain` of a worker node while requests flow.
     - The PDBs allow it and the requests keep succeeding.
     - The node chosen hosts no local data service; the gateway pod is moved off it first.
   - **AKS dry run.** The AKS overlays, rendered with the example `release.env`, are accepted by a
     real API server (`--dry-run=server`).
   - **Resource use.** Container working sets are reported against the requests.
6. **Clean-up.** The cluster is deleted unless `--keep`. `--reuse` keeps an existing cluster and
   recreates only the namespace.

The report is printed and saved to `%TEMP%/pp-k8s-local-report.json` (`$TMPDIR` on Linux/macOS).

## What it cannot prove

The local cluster stands in for AKS. Things only AKS can prove are listed in
[the verification report](../verification-report.md) and the milestone-35 limitations in
[project-state.md](../project-state.md):

- the managed `approuting-istio` class and its webhooks;
- Cilium;
- the Key Vault CSI driver with workload identity;
- Entra sign-in to PostgreSQL and Redis;
- Azure Load Balancer timeouts and the public IP.
