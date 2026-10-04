# Kubernetes release runbook (milestone 35)

> **Nothing has been released.**
>
> - These commands change a live AKS cluster.
> - Run them only after the Azure environment exists ([provisioning.md](../azure/provisioning.md),
>   steps 1–8) **and** a release has been explicitly authorized: subscription, cost, public host name
>   and the change itself (project plan workflow R3).
> - Every step before "Release" is read-only.

Design: [ADR 0027](../decisions/0027-kubernetes-gateway-and-release.md). Manifests:
[deploy/kubernetes/](../../deploy/kubernetes/). Database policy:
[database-releases.md](database-releases.md). Scaling: [scaling.md](scaling.md). Network and SSE:
[networking.md](networking.md).

**Shell:** Bash (Linux, macOS, WSL or Cloud Shell) from the repository root.

**Tools:** Azure CLI **≥ 2.86** (the app-routing Gateway API flags), `kubectl` + `kubelogin`
(`az aks install-cli`), Node.js 24 with `npm ci` done.

## 0. One-time cluster preparation (after provisioning step 6)

```bash
# Managed Gateway API CRDs (v1.4.1 standard on AKS 1.35) + the app routing Gateway API implementation.
az aks update -g "$RG" -n "$AKS" --enable-gateway-api --enable-app-routing-istio
kubectl get gatewayclass approuting-istio           # ACCEPTED=True
kubectl get crd gateways.gateway.networking.k8s.io -o jsonpath='{.metadata.annotations.gateway\.networking\.k8s\.io/bundle-version}'   # v1.4.1
kubectl -n aks-istio-system get pods                 # istiod Running
```

**TLS certificate** for the public host name (manual choice; any CA). Store the PEM certificate chain
and the private key as two Key Vault secrets. Only the `tls-sync` identity can read them:

```bash
az keyvault secret set --vault-name "$KV" --name gateway-tls-crt --encoding utf-8 --output none --file fullchain.pem
az keyvault secret set --vault-name "$KV" --name gateway-tls-key --encoding utf-8 --output none --file privkey.pem
shred -u privkey.pem 2>/dev/null || rm -f privkey.pem
```

Per-secret grants were added to provisioning step 8 for milestone 35:

- `tls` → `gateway-tls-crt` and `gateway-tls-key`;
- `api` and `outbox` → `anthropic-api-key`.

The Key Vault secrets referenced by the SecretProviderClasses **must all exist**, even in mock mode,
or the pods stay in `ContainerCreating`. In mock mode, store a placeholder such as `unused` for the
Anthropic and Alpaca keys.

## 1. Release parameters (`release.env`, non-secret)

```bash
# Environment part: names, endpoints and identity IDs from the infra deployment outputs (read-only).
node scripts/k8s-release.mjs env --deployment "$DEPLOYMENT" --hostname portfolio.example.org \
  --entra-client-id <sign-in app client ID> --data-mode mock --agent-mode mock > /tmp/env.part
# Images: resolves the commit tag pushed by release.yml to digests (read-only; needs AcrPull or Reader on ACR).
node scripts/k8s-release.mjs images --registry "$(out acrName)" --tag "$GIT_SHA" > /tmp/images.part
cat /tmp/images.part /tmp/env.part > deploy/kubernetes/overlays/aks/release.env    # git-ignored
npm run validate:k8s -- --release-env deploy/kubernetes/overlays/aks/release.env
```

`validate:k8s` refuses example values, a mutable tag, a URL with a password, shared identities, and
any rendered configuration the application itself would reject.

- `AGENT_MODE=claude` needs `--model-id`: a manual choice, never guessed.
- Live data (`--data-mode live`) needs the Alpaca storage/display rights confirmed (milestone 12).

## 2. Inspect before changing anything

```bash
az aks get-credentials -g "$RG" -n "$AKS" --overwrite-existing && kubelogin convert-kubeconfig -l azurecli
node scripts/k8s-release.mjs plan                  # prints the exact ordered commands
node scripts/k8s-release.mjs render --out .release/current
kubectl diff --server-side --field-manager=portfolio-pilot-release -f .release/current/2-app.yaml   # what will change
node scripts/k8s-release.mjs apply --context "$AKS" --i-am-authorized-to-release portfolio.example.org --dry-run
```

`--dry-run` stops after the server-side dry run. The API server and its admission webhooks (Pod
Security, the add-on webhooks) validate every object. Nothing is changed.

## 3. Release (authorization required)

```bash
node scripts/k8s-release.mjs apply --context "$AKS" --i-am-authorized-to-release portfolio.example.org
```

The script runs, in order, and stops at the first failure:

1. a server-side dry run of both units, with any Pod Security warnings printed;
2. the migration Job `db-migrate-<RELEASE_ID>`, applied and **awaited** (15 min). If it is `Failed`,
   the release stops and the application is untouched;
3. the application, applied server-side under field manager `portfolio-pilot-release`;
4. `rollout status` for every Deployment (`maxUnavailable: 0`, readiness-gated);
5. the Gateway reaching `Programmed`;
6. the anonymous smoke test against `https://<host>`.

The same function (`releaseToCluster` in `scripts/k8s-lib.mjs`) is what `npm run verify:k8s-local`
runs against kind.

**From GitHub:** `release.yml` → job `deploy` (environment `production`, required reviewers) does steps
1–3 with OIDC. The environment variables are listed in the workflow header.

## 4. Smoke tests after the release

```bash
# Anonymous (also run by apply): TLS, SPA, headers, readiness through the gateway, redirect, 401 on /api/events.
node scripts/k8s-smoke.mjs --origin https://portfolio.example.org --http-origin http://portfolio.example.org --hold-seconds 0
# Authenticated, read-only: sign in with a browser, copy the Cookie request header of any /api call into a
# private file, then hold an idle event stream for 5.5 min (beyond the 120 s /api timeout and Envoy's 5 min
# stream idle timeout). Never use --mutate against real user data.
node scripts/k8s-smoke.mjs --origin https://portfolio.example.org --cookie-file ~/.pp-session-cookie --hold-seconds 330
rm ~/.pp-session-cookie
```

Azure-side checks that only a live cluster can answer. They complete
[provisioning.md step 9](../azure/provisioning.md#9-smoke-tests-after-milestone-35-manifests):

```bash
kubectl -n portfolio-pilot get pods -o wide                                  # all Running/Ready, spread over nodes
kubectl -n portfolio-pilot exec deploy/api -- node -e "fetch('http://127.0.0.1:3001/api/health/ready').then(r=>r.text()).then(console.log)"   # postgres/redis up via Entra tokens
kubectl -n portfolio-pilot exec deploy/api -- sh -c 'ls /mnt/secrets'        # AUTH_SECRET ENTRA_CLIENT_SECRET ... (names only)
kubectl -n portfolio-pilot get secret portfolio-pilot-tls -o jsonpath='{.type}'   # kubernetes.io/tls (the only synced Secret)
kubectl -n portfolio-pilot logs deploy/worker-agent | grep operations.snapshot | tail -1
kubectl -n portfolio-pilot get events --field-selector type=Warning
kubectl -n portfolio-pilot logs deploy/portfolio-pilot-approuting-istio | tail  # Envoy access log; response flags UT/SI = timeouts
```

## 5. If something goes wrong

| Symptom | Action |
| --- | --- |
| Migration Job `Failed` | **Stop.** The app is unchanged. Read `kubectl logs job/db-migrate-<id>`, then follow [database-releases.md](database-releases.md#how-a-migration-runs). Retry only with a new `RELEASE_ID`. |
| Rollout stuck (`rollout status` timeout) | `kubectl -n portfolio-pilot describe pod <new pod>`. A pod stuck in `ContainerCreating` usually means a CSI mount failure (missing secret or grant). An old ReplicaSet keeps serving (`maxUnavailable: 0`). |
| New version misbehaves | `kubectl -n portfolio-pilot rollout undo deployment/<name>` for the affected Deployments. The database is **not** rolled back, and does not need to be, thanks to expand/contract. Then fix forward. |
| Data damaged by a migration | Restore to a new server ([database-releases.md](database-releases.md#backup-and-restore)). |
| SSE streams drop every N minutes | Envoy access log response flags; compare N with 5 min (stream idle), 4 min (LB idle) and the heartbeat (15 s). |

## 6. Removing the application

```bash
kubectl delete namespace portfolio-pilot      # workloads, gateway (and its public IP), jobs, policies
az aks update -g "$RG" -n "$AKS" --disable-app-routing-istio   # optional
```

The database, Redis, Key Vault and Blob data are untouched; their cleanup is in
[provisioning.md](../azure/provisioning.md#cleanup).
