# PortfolioPilot — Milestone 35: Kubernetes deployment and release procedures

PortfolioPilot is a teaching project: a stock portfolio manager with a live news feed, AI chat built
on the Claude Agent SDK, watchlists and alerts. It is built one milestone at a time. This README
explains **milestone 35**: what was asked, what was built, what was actually verified and what is
still missing.

> **Nothing was deployed to the cloud.** Every result below comes from your own machine: static
> checks and a throwaway local Kubernetes cluster that was deleted afterwards. Releasing to Azure
> needs separate, explicit authorization.

Want more detail? The project contract is in [AGENTS.md](AGENTS.md) and the current status in
[docs/project-state.md](docs/project-state.md). The design decision is
[ADR 0027](docs/decisions/0027-kubernetes-gateway-and-release.md), and the step-by-step teaching
notes are in [lesson 35](docs/lessons/35-kubernetes-deployment-and-release.md).

---

## 1. Purpose

### What the prompt asked for

Earlier milestones built the application and packaged it:

- the release container images (milestone 33);
- the Azure infrastructure as code (milestone 34).

Milestone 35 asked the coding agent to describe **how those containers run on Azure Kubernetes
Service (AKS)** and **how a new version is released safely**. That includes:

- manifests for the five workloads: frontend, API, ingestion worker, outbox dispatcher and agent
  worker;
- resource requests and limits, health probes, service accounts and cloud identities, security
  settings, network rules, and settings that protect availability during maintenance;
- one public HTTPS address that serves the website and routes `/api` to the backend, and that
  keeps long-lived Server-Sent Events (SSE) streams working;
- a database migration that runs once, before the new version starts, plus written rules for safe
  schema changes, backups and rollbacks;
- separate scaling for the API and the workers;
- validated manifests, prepared commands and smoke tests. **No real release.**

### Key terms (short definitions)

| Term | Meaning |
| --- | --- |
| **Kubernetes** | A system that runs containers on a group of machines (nodes), restarts them when they fail and replaces them gradually during updates. |
| **AKS** | Azure Kubernetes Service, Microsoft's managed Kubernetes. |
| **Manifest** | A YAML file describing what Kubernetes should run (for example a *Deployment* of 2 API pods). |
| **Kustomize** | A tool built into `kubectl` that combines a shared *base* of manifests with environment-specific *overlays* (for example `aks` and `local`). No templating language. |
| **Pod** | One running instance of a container (plus its settings). |
| **Probe** | A health check Kubernetes calls. *Readiness* means "may it receive traffic?"; *liveness* means "should it be restarted?". |
| **Gateway (Gateway API)** | The entry point from the internet. It terminates HTTPS and routes paths to services. |
| **SSE (Server-Sent Events)** | A long-lived HTTP response that the server uses to push events (news, trades, AI answer text) to the browser. |
| **Migration** | A versioned database schema change (here with Prisma). |
| **Expand/contract** | Changing a schema in small, backward-compatible steps, so old and new code both work during a release. |
| **PodDisruptionBudget (PDB)** | A rule that limits how many pods may be stopped at once during maintenance. |
| **NetworkPolicy** | A firewall rule between pods ("only the gateway may reach the API"). |
| **Workload identity** | A way for a pod to get Azure credentials without any stored password. |
| **HPA** | Horizontal Pod Autoscaler: adds or removes pods based on a metric such as CPU. |

### Why it matters and what you will learn

- **Choosing infrastructure by its support lifecycle.** The popular `ingress-nginx` stopped being
  maintained in March 2026, so a new deployment should not start on it.
- **Keeping SSE streams alive behind proxies,** and why "sticky sessions" are not the answer.
- **Running migrations as a controlled release step,** and why rolling back the application cannot
  undo a database change.
- **Making restarts and node maintenance invisible to users,** with probes, drains and disruption
  budgets.
- **Verifying a release by actually running it:** traffic, rollouts and drains, not just YAML
  syntax.

---

## 2. Steps performed

The steps below are in the order they were done.

### Step 1 — Read the project state and existing designs

The agent read [AGENTS.md](AGENTS.md), [docs/project-state.md](docs/project-state.md) and the
milestone-34 Azure documents ([docs/azure/](docs/azure/)). It also read the application code that the
manifests depend on:

- the API's drain logic (`apps/api/server.mjs`);
- the worker health server (`apps/worker/src/lifecycle.ts`);
- the configuration schema (`packages/config/src/server.ts`);
- the SSE heartbeat interval (`apps/api/lib/event-hub.ts`, 15 seconds).

### Step 2 — Check the current gateway options before choosing one

Microsoft's documentation was read on 2026-10-04:

- The community **Ingress-NGINX** project ended maintenance in March 2026. AKS's **managed NGINX**
  gets critical patches only until **November 2026**.
- The **AKS application routing add-on with the Gateway API** (class `approuting-istio`) has been
  generally available since April 2026. It manages Envoy proxies for you.
- On AKS 1.35, the managed Gateway API version is **v1.4.1 (standard channel)**. It supports route
  timeouts but not automatic retries.

**Decision:** use `approuting-istio`, and pin the AKS version to `1.35` so the gateway version is
predictable. The reasons and the rejected alternatives are recorded in
[ADR 0027](docs/decisions/0027-kubernetes-gateway-and-release.md).

### Step 3 — Write the manifests with Kustomize

```text
deploy/kubernetes/
├── base/                 web, api, 3 worker roles, service accounts, HPA, PDBs, app network rules, config/*.env
├── gateway/              one Gateway (HTTPS 443 + HTTP 80 redirect) and the HTTPRoutes
├── migrate/              the one-off database migration Job
├── policies/             default-deny + DNS network policies (shared)
├── components/aks-platform/   namespace with Pod Security labels + AKS egress rules
├── overlays/aks/         AKS: workload identity, Key Vault secret files, TLS sync, release.env.example
├── overlays/aks-migrate/ AKS migration unit
├── overlays/local-data/  local only: throwaway PostgreSQL + Redis
├── overlays/local-migrate/, overlays/local/   local only: same base, demo settings
└── local/kind-cluster.yaml   local test cluster definition
```

Key decisions:

- **Kustomize instead of Helm.** It needs only `kubectl`, and five workloads with one parameter file
  do not need a template language.
- **Every pod is locked down.**
  - It runs as a non-root user.
  - Its root filesystem is read-only (only `/tmp` and the AI workspace are writable).
  - It drops all Linux capabilities and receives no Kubernetes API token.
  - It has requests and limits sized from measured memory use.
- **Graceful shutdown.** Each pod gets more time to stop than the application needs to drain:
  - API: 5 s pre-stop pause + 20 s drain, inside 35 s;
  - agent worker: 100 s drain, inside 115 s.
- **Disruption budgets.** At least one web and one API pod stay up. The single-replica workers use
  `maxUnavailable: 1`, so they can never block node maintenance.
- **Secrets as files.**
  - Each workload reads its own secrets from Azure Key Vault, using **its own** identity.
  - The secrets arrive as files; a one-line shell command turns them into environment variables
    before starting Node.js.
  - No application secret is stored as a Kubernetes Secret. The only exception is the HTTPS
    certificate, which the Gateway requires as one.
- **Network rules.**
  - By default no pod may talk to anything.
  - Then only the designed paths are opened: the gateway to web and API, the backends to the
    database and Redis, and HTTPS to the internet for Entra sign-in and the AI/market-data APIs.

### Step 4 — Configure the one public origin for SSE

The HTTPRoute sends:

| Path | Goes to | Timeout | Why |
| --- | --- | --- | --- |
| `/api/events` | API | **none** (`0s`) | the SSE stream stays open for minutes |
| `/api/...` | API | 120 s | ordinary API calls |
| everything else | web (nginx with the React build) | 30 s | static files |
| `http://...` | redirect to `https://` | — | one secure origin |

The API sends a heartbeat every 15 s, below every idle timeout on the path (Envoy 5 min, Azure Load
Balancer 4 min).

Sticky sessions are **not** used. Any API pod can serve any user, because every pod reads the shared
Redis event stream itself. After a disconnect, the browser reconnects with its last event ID.

### Step 5 — Make the database migration a release step

The Job `db-migrate-<release id>` runs `prisma migrate deploy` once, as the database owner role. The
release script **waits** for it to succeed before it touches the application. If the migration
fails, the release stops and the running version keeps serving.

The rules for safe changes are written in
[docs/kubernetes/database-releases.md](docs/kubernetes/database-releases.md):

- expand/contract;
- backups and point-in-time restore;
- why `kubectl rollout undo` does **not** undo a migration.

### Step 6 — Scaling policy

- **API:** an HPA keeps 2–4 pods based on CPU and memory, and removes pods slowly so SSE clients do
  not all reconnect at once.
- **Workers:** a documented **manual** policy, based on how old the oldest queued job is. The agent
  worker already logs this every minute. A query for Azure Log Analytics is included.
- Why CPU alone is a poor signal is explained in [docs/kubernetes/scaling.md](docs/kubernetes/scaling.md).
  For example, idle SSE streams use memory but almost no CPU.

### Step 7 — Release tooling and the GitHub workflow

| File | Purpose |
| --- | --- |
| `scripts/k8s-release.mjs` | `env` and `images` build the non-secret `release.env` from Azure outputs and image digests. `plan` prints the ordered commands. `render` writes the final YAML. `apply` runs the release (refuses to start unless you repeat the public host name). |
| `scripts/k8s-lib.mjs` | Shared helpers, including `releaseToCluster`: dry run → migration Job, awaited → application → rollouts → gateway ready. |
| `scripts/k8s-smoke.mjs` | Smoke test of the public origin, optionally holding an SSE stream open for 330 s. |
| `scripts/validate-k8s.mjs` | Static policy checks (no cluster needed), with a self-test. |
| `scripts/verify-k8s-local.mjs` | Full end-to-end test on a local kind cluster. |
| `.github/workflows/release.yml` | The `deploy` job now runs the release. It is still behind three gates: manual trigger on `main`, `RELEASE_ENABLED`, and reviewer approval on the `production` environment. |

### Step 8 — Small infrastructure and documentation fixes found along the way

- **New identity.** `id-pp-dev-tls` reads only the HTTPS certificate
  (`infra/azure/modules/workload.bicep`). It is excluded from database roles.
- **Pinned AKS version.** `kubernetesVersion = '1.35'` was added to
  `infra/azure/parameters/dev.bicepparam`.
- **Corrected credential matrix.** Reading the code showed that the API and the outbox dispatcher
  also call the AI model (shared article analysis). They now get the Anthropic key, which milestone
  34 had missed.
- **New dev dependency.** `yaml` 2.9.1 parses rendered manifests in the scripts.

### Step 9 — Verify (see section 3)

Tools were downloaded into the git-ignored folder `.local/tools/`, with checksums verified:

- `kind` 0.33.0 (Kubernetes in Docker, for a local test cluster);
- `istioctl` 1.30.5 (Istio is the engine behind `approuting-istio`).

---

## 3. Results achieved

All numbers below were **observed** on 2026-10-04 (Windows 11, Docker Desktop).

### Static validation

```text
$ npm run validate:k8s -- --self-test
PASS release parameters (committed example)
PASS every overlay renders (aks, aks-migrate, local, local-migrate, local-data)
PASS aks: pod policy
PASS aks: secrets, placeholders and identities
PASS aks: single HTTPS origin and SSE routing
PASS aks: workload configuration passes the server config schema
...
PASS self-test detects pod reading another identity's Key Vault class
PASS self-test detects SSE route timeout not disabled
...
validate:k8s 30 passed, 0 failed
```

The "self-test" plants 15 deliberate mistakes (for example a privileged container, or an SSE route
with a timeout) and confirms each one is caught.

Other checks:

- `npm run test:k8s`: 5/5.
- `npm run test:proxy`: 7/7.
- `npm run typecheck`, `npm run lint` and `npm run check:browser-boundary`: all succeeded.
- `npm run validate:infra`: 7/7.
- `actionlint` on both workflows: no findings.

### End-to-end run on a local cluster

`npm run verify:k8s-local` created a 3-node Kubernetes 1.35.8 cluster with Istio 1.30.5, ran the same
release function that the AKS release uses, tested it, and deleted the cluster. Final run:
**15 passed, 0 failed**.

| Check | Observed result |
| --- | --- |
| Release order | Migration Job completed 08:00:55, first application Deployment created 08:00:58 |
| Autoscaler | API raised to its minimum of 2 pods |
| Pod Security | No warnings for 7 application pods |
| Pod posture | API/workers run as uid 10001, web as 101; no token; code read-only |
| Network rules (8 flows) | web→API open; web→database blocked; workers→API blocked; agent→internet blocked; API→database open |
| Smoke test (9 checks) | Website, headers, readiness, redirect, demo sign-in, trade → live event |
| Long SSE stream | Held idle for **330 s**, with **20 heartbeats 15.6–15.9 s apart** (so nothing buffers the stream) |
| API rolling restart under load | 67 requests OK, **0 failed**; the stream moved to a new pod and kept receiving events |
| Worker restarts | All three roles drained cleanly; an AI run in progress **completed** |
| Node maintenance (`kubectl drain`) | Both API pods were evicted one at a time; 36 requests OK, **0 failed** |
| AKS manifests | Accepted by a real Kubernetes API server in dry-run mode (51 objects) |
| Memory in use | API 175 MiB, agent 170, outbox 155, ingestion 129, web 17 |

Example of the release log produced by the shared release function:

```text
server-side dry run passed: migration (4 objects)
server-side dry run passed: application (31 objects)
migration Job db-migrate-local created
migration Job complete:
All migrations have been successfully applied.
application applied
rolled out: Deployment/web
rolled out: Deployment/api
...
gateway programmed: portfolio-pilot
```

### What this means for the application

On a Kubernetes cluster, PortfolioPilot now:

- serves the website and API from one HTTPS address;
- keeps live updates flowing through restarts and node maintenance;
- upgrades its database exactly once, before new code runs;
- refuses to start a release that is misconfigured.

---

## 4. How to run and verify

### Prerequisites

- **Node.js 24.21.0 and npm 11.19.0.** Then install the dependencies:
  ```bash
  npm ci --ignore-scripts
  ```
- **`kubectl`.** Docker Desktop includes it; Kustomize is built in.
- **For the end-to-end test only:**
  - Docker Desktop (about 6 GB of free memory recommended);
  - `openssl` (included with Git for Windows);
  - `kind` 0.33.0 and `istioctl` 1.30.5 (download steps below);
  - the four release images.
- **No cloud account and no API keys are needed.**

### A. Static checks (about 1 minute, no cluster)

```bash
npm run build --workspace @portfolio-pilot/config   # validate:k8s uses the app's config schema
npm run validate:k8s -- --self-test                  # expect: 30 passed, 0 failed
npm run test:k8s                                     # expect: pass 5, fail 0
```

To see the final YAML for an environment:

```bash
kubectl kustomize deploy/kubernetes/overlays/local
```

### B. Full local release test (about 20–30 minutes)

1. Build the release images, if you have not already:

   ```bash
   docker compose -f compose.production.yaml build
   ```

2. Download the tools into `.local/tools/` (Windows binaries shown; use the `linux-amd64` files on
   Linux):

   ```bash
   mkdir -p .local/tools && cd .local/tools
   curl -sSLo kind.exe https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-windows-amd64
   curl -sSLo istioctl.zip https://github.com/istio/istio/releases/download/1.30.5/istioctl-1.30.5-win.zip
   unzip -o istioctl.zip && cd ../..
   ```

   Compare the checksums with the `.sha256` files published next to each download. Exact commands
   are in [docs/kubernetes/local-verification.md](docs/kubernetes/local-verification.md).

3. Run the test. Free ports 8443 and 8480 first.

   ```bash
   npm run verify:k8s-local
   ```

   - **Expected ending:** `"passed": 15, "failed": 0`. The cluster is deleted at the end.
   - The report is also saved to `pp-k8s-local-report.json` in your temp folder.
   - Options:
     - `-- --keep` keeps the cluster for exploring;
     - `-- --reuse` reuses an existing one;
     - `-- --hold-seconds 40` shortens the SSE hold.

4. **Optional: browse the app.** After a `--keep` run:

   ```bash
   kubectl --context kind-pp-m35 -n portfolio-pilot port-forward svc/portfolio-pilot-istio 8443:443
   ```

   Then open https://localhost:8443 and accept the self-signed certificate warning. Sign in with
   the demo account **alice** or **bob**. Delete the cluster afterwards:

   ```bash
   .local/tools/kind.exe delete cluster --name pp-m35
   ```

PowerShell users can run the same `npm` commands. Use `Invoke-WebRequest` for the downloads.

### C. Releasing to Azure (requires authorization — not done)

The read-only preparation and the actual release are in
[docs/kubernetes/release-runbook.md](docs/kubernetes/release-runbook.md). The core commands are:

```bash
node scripts/k8s-release.mjs plan                       # prints every step, changes nothing
node scripts/k8s-release.mjs apply --context <aks> --i-am-authorized-to-release <host> --dry-run
```

---

## 5. Limitations and unfinished work

- **Nothing was tested on Azure.**
  - No AKS cluster exists, and a release needs explicit approval of the subscription, cost and host
    name.
  - Locally, upstream Istio stood in for the managed `approuting-istio`, and kind's network plugin
    stood in for Cilium.
  - Unverified: Key Vault secret mounting with workload identity, Entra sign-in to PostgreSQL and
    Redis, the Azure load balancer, and the HTTPS certificate from Key Vault.
- **Azure CLI too old.** The gateway add-on commands need Azure CLI **2.86 or newer**; 2.80 is
  installed. They were copied from Microsoft's documentation and not run.
- **Telemetry collector not deployed.** In AKS the apps currently export no traces or metrics
  (`OTEL_*_EXPORTER=none`).
- **Worker scaling is manual.** The thresholds (for example "scale the agent worker when the oldest
  queued job is older than 30 s") are starting points that have not been load-tested. Automatic
  queue-based scaling (KEDA) is a documented next step.
- **Redirect port.** In the local test, the HTTP→HTTPS redirect kept port `:8480` because of the
  port-forward. Production redirects (no port in the address) are expected to go to the default
  HTTPS port, but this has not been observed.
- **Client IP.** With the default load balancer setting, the API sees a node address instead of the
  visitor's IP. The application's own rate limits are per user, so they are unaffected.
- **Not re-run this milestone:** `test:unit`, `test:integration`, `test:browser` and
  `verify:containers`. No application code or image changed since they last passed in milestone 34.
- **The GitHub release workflow has never run.** This workspace has no Git remote, and the
  `production` environment variables (`AKS_RESOURCE_GROUP`, `AKS_NAME`, `PUBLIC_HOSTNAME`,
  `K8S_RELEASE_ENV`) do not exist yet.
- **Side effect on the development machine.** A help command auto-installed the `redisenterprise`
  Azure CLI extension. Remove it with `az extension remove --name redisenterprise` if you don't want
  it.

The next milestone (36) finishes the capstone and the teaching materials.
