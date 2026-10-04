# 35. Create Kubernetes deployment and release procedures

Decision record: [ADR 0027](../decisions/0027-kubernetes-gateway-and-release.md). Operator
documentation lives in [docs/kubernetes/](../kubernetes/):

- [release runbook](../kubernetes/release-runbook.md)
- [database changes: migrations, expand/contract, backup/restore](../kubernetes/database-releases.md)
- [scaling policy](../kubernetes/scaling.md)
- [gateway, SSE and network policy](../kubernetes/networking.md)
- [local verification](../kubernetes/local-verification.md)

**Nothing was provisioned or released.** Everything below ran on a throwaway local cluster.

## What works

- **Kustomize manifests** in `deploy/kubernetes/` for the five workloads:
  - web (nginx, uid 101) and the API (uid 10001);
  - the ingestion, outbox and agent worker roles (one image).

  Each has:
  - requests/limits sized from measured working sets;
  - startup, readiness and liveness probes;
  - a service account of its own with no token;
  - restricted-profile security contexts and read-only roots with `emptyDir` scratch;
  - preStop delays and termination grace above every drain deadline;
  - PodDisruptionBudgets that never block a node drain;
  - per-workload ConfigMaps whose hash rolls the pods on change.
- **One HTTPS origin** through the AKS application routing add-on's Gateway API implementation
  (`approuting-istio`).
  - `/api/events` has its route timeout disabled. `/api` is bounded at 120 s and `/` at 30 s.
  - HTTP only redirects.
  - The security headers nginx used to add to `/api` are set on the route.
- **Release procedure** (`scripts/k8s-release.mjs`, the shared `releaseToCluster`):
  1. a server-side dry run;
  2. a one-off **migration Job** `db-migrate-<RELEASE_ID>`, awaited (a failure stops everything with
     the application untouched);
  3. then the application, every rollout and the Gateway;
  4. then an anonymous smoke test.

  `release.yml`'s `deploy` job now runs this behind the existing `RELEASE_ENABLED`, `main`-only and
  required-reviewer gates.
- **AKS identity and secrets.**
  - Each runtime workload reads Key Vault through the CSI driver with **its own** workload identity.
  - Secrets arrive as files named after environment variables. Only the gateway certificate becomes
    a Kubernetes Secret, synced by a dedicated `tls-sync` pod with a new identity `id-pp-dev-tls`.
- **NetworkPolicy:** default deny (ingress and egress) for every application pod, then only the
  designed flows. Data services are reached only through the private-endpoint subnet, plus public
  443 for Entra and the providers; link-local (IMDS) is excluded.
- **Independent scaling.**
  - The API has an HPA (2–4) on CPU and memory.
  - The workers follow a documented manual policy keyed on queue **age** and depth, which the agent
    worker already reports.
  - [scaling.md](../kubernetes/scaling.md) explains why CPU is not the SSE signal.
- **Validation and verification commands:**
  - `npm run validate:k8s` (static, with a 15-violation self-test);
  - `npm run test:k8s` (release parameter unit tests);
  - `npm run verify:k8s-local` (the full release and traffic tests on kind + Istio).

## Part 1: Choose the gateway by its support lifecycle, not by habit

`ingress-nginx` was the default answer for years, but checking the dates changed it:

- the community project ended maintenance in **March 2026**;
- AKS's managed NGINX gets only critical patches until **November 2026**.

A deployment started in October 2026 on it would be migrated within weeks. The AKS app-routing
**Gateway API** implementation has been GA since April 2026. It is managed (Envoy proxies with
their own HPA and PDB, upgraded with AKS) and free.

The same check exposed constraints that shaped the manifests:

- The managed CRDs are the Gateway API **standard** channel only: v1.4.1 on AKS 1.35. That means
  `timeouts` but no `retry`. Drain safety therefore cannot rely on gateway retries; it relies on
  preStop, readiness and `maxUnavailable: 0`.
- No body-size or rate limits at the gateway. The API already enforces both, which is why they were
  built in the application in milestones 29–30.
- The Kubernetes minor decides the bundle, so `kubernetesVersion` is now pinned to `1.35`.

## Part 2: Long-lived SSE through a proxy, without sticky sessions

The checklist is a chain of idle timers, each of which must be shorter than the heartbeat interval
or disabled:

- the route timeout (disabled for `/api/events` only; the 120 s `/api` rule would cut every stream);
- Envoy's stream idle timeout (5 min);
- the Azure LB TCP idle timeout (4 min);
- the API heartbeat (15 s) sits well below all of them.

Buffering is checked by *timing*: heartbeats must arrive ~15 s apart, not in a burst.

Stickiness would make the tests pass for the wrong reason. Events reach a stream on any replica
because every replica reads Redis Streams itself, and a reconnect carries the signed
`Last-Event-ID`. The local verification proves the hard case: every API pod is replaced while a
stream is open and requests flow. The stream ends, reconnects to a new pod, and receives the next
event.

## Part 3: Migrations are a release step

- The migration runs **once**, as a Job, **before** the application changes, with the owner role.
  The runtime roles cannot run DDL at all.
- `backoffLimit: 0`: a failed migration needs a human, not a retry.
- Rolling the application back never rolls the database back. Prisma has no down-migrations, and
  "undoing" usually destroys data.
- That is why every change is **expand/contract**. During a rollout, and after a rollback, two
  application versions share one schema.
- [database-releases.md](../kubernetes/database-releases.md) has the table of safe patterns and the
  restore procedure: point-in-time restore to a new server, then flush Redis because it only holds
  derived data.

## Part 4: Secrets as files and identities that cannot be mixed up

- CSI `secretObjects` would copy every provider key into etcd as a Kubernetes Secret. Mounting files
  keeps them in the driver's tmpfs.
- The container command turns each file into the variable it is named after
  (`objectAlias: AUTH_SECRET`), then `exec`s node. tini stays PID 1, so signal handling and the
  drain are unchanged. Locally, the same path is fed by an ordinary Secret volume.
- `validate:k8s` cross-checks the identity of every pod against every SecretProviderClass it mounts.
  A copy-paste of the wrong `clientID` would otherwise let one workload read another's keys.
- Reading the code changed the credential matrix. The shared article analysis is a model call in
  the **API** and the **outbox dispatcher** too, so those identities now get `anthropic-api-key`.

## Part 5: Verify a release, not just YAML

Rendering and schema checks catch typos. They do not catch:

- a probe that never succeeds;
- a policy that blocks the database;
- a drain that kills requests;
- a stream that a proxy cuts after two minutes.

So `verify:k8s-local` runs the real release function against a 3-node kind cluster with upstream
Istio (the engine behind `approuting-istio`) and exercises traffic, rollouts and drains. One more
check runs the application's **own config schema** over each rendered workload environment. It
catches, for example, an Entra setting placed in the shared ConfigMap, which would make every
worker refuse to start.

## Teaching points

- A PDB of `minAvailable: 1` on a single-replica Deployment blocks every node upgrade. Use
  `maxUnavailable: 1` and make the workload safe to restart.
- With server-side apply, a `replicas` field on an autoscaled Deployment resets the HPA on every
  release. Leave it out.
- `terminationGracePeriodSeconds` must exceed preStop + the application's own drain deadline + a
  margin. The validator computes it from the rendered ConfigMaps.
- Istio copies Gateway labels onto the proxy pods. A `part-of` label on the Gateway would put the
  gateway under your own default-deny policy.
- Kustomize computes ConfigMap name hashes **after** `replacements`, so a changed `release.env`
  value rolls the pods (checked empirically).

## Common mistakes

- Running `prisma migrate deploy` in an init container or at API start: every replica races, and a
  crash loop retries a half-applied migration.
- Expecting `kubectl rollout undo` to restore the previous schema.
- Turning on session affinity "for SSE" instead of making reconnect-and-replay work.
- Treating the HTTP listener as a second origin. It must only redirect, or cookies and
  `AUTH_BASE_URL` disagree.
- Testing only with `--dry-run`: the first real drain or rollout is where timeouts, probes and
  policies meet.

## Results

See [project-state.md](../project-state.md#latest-milestone-report---35) and the
[verification report](../verification-report.md#kubernetes-release-milestone-35).

## Changed files

**Created:**

- `deploy/kubernetes/`:
  - `base/` (`kustomization.yaml`, `service-accounts.yaml`, `web.yaml`, `api.yaml`, `workers.yaml`,
    `network-policies.yaml`, `config/*.env`);
  - `gateway/`, `migrate/`, `policies/`, `components/aks-platform/`;
  - `overlays/aks/` (`kustomization.yaml`, `replacements.yaml`, `release.env.example`,
    `secret-provider-classes.yaml`, `workload-identity.yaml`, `tls-sync.yaml`);
  - `overlays/aks-migrate/`, `overlays/local/`, `overlays/local-migrate/`, `overlays/local-data/`;
  - `local/kind-cluster.yaml`.
- `scripts/`: `k8s-lib.mjs`, `k8s-release.mjs`, `k8s-smoke.mjs`, `validate-k8s.mjs`,
  `verify-k8s-local.mjs`, `k8s.test.mjs`.
- `docs/kubernetes/`: `release-runbook.md`, `database-releases.md`, `scaling.md`, `networking.md`,
  `local-verification.md`.
- `docs/decisions/0027-kubernetes-gateway-and-release.md`, and this lesson.

**Modified:**

- `.github/workflows/release.yml`: the manifest job uploads digest refs; the `deploy` job runs the
  release.
- `infra/azure/modules/workload.bicep`: the `tls` identity.
- `infra/azure/parameters/dev.bicepparam`: `kubernetesVersion = '1.35'`.
- `docs/azure/provisioning.md`, `credentials.md`, `network.md`.
- `docs/decisions/README.md`, `docs/versions.md`, `docs/verification-report.md`,
  `docs/project-state.md`.
- `package.json` (scripts and the `yaml` 2.9.1 dev dependency), `package-lock.json`, `.gitignore`.

No application code changed, so the release images from milestone 33/34 were used unchanged.
