# Provisioning and cleanup runbook (milestone 34)

> **Nothing in this repository has been provisioned.** Step 5 creates paid resources, about
> USD 334–370 per month at dev sizes ([cost-estimate.md](cost-estimate.md)). Run it only with
> explicit authorization from whoever owns the subscription and budget. Every other step before
> it is read-only.

**Shell.** Bash on Linux, macOS or WSL, or Azure Cloud Shell, run from the repository root. Process
substitution (`<(...)`) passes secrets to `az` without putting them on the command line, in files
or in shell history. Git Bash on Windows cannot hand `/dev/fd` paths to the Windows `az`.

**Tools.** Azure CLI ≥ 2.80 with Bicep 0.41.2 (`az bicep version`), Node.js 24, OpenSSL, and
`kubectl` plus `kubelogin` (`az aks install-cli`).

## 1. Sign in and select the subscription (manual choice)

```bash
az login --tenant <TENANT_ID>
az account set --subscription <SUBSCRIPTION_ID>
az account show --query "{subscription:id, tenant:tenantId, user:user.name}" -o table
for ns in Microsoft.ContainerService Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL Microsoft.Cache \
  Microsoft.KeyVault Microsoft.Storage Microsoft.OperationalInsights Microsoft.Insights Microsoft.Network \
  Microsoft.ManagedIdentity Microsoft.Consumption; do az provider register --namespace "$ns" --output none; done
```

## 2. Preflight the region: availability and quota (read-only)

```bash
LOCATION=eastus2
az vm list-skus --location "$LOCATION" --size Standard_D2s_v6 --all --query "[].{sku:name, restrictions:restrictions}" -o json   # restrictions must be []
az vm list-usage --location "$LOCATION" --query "[?name.value=='standardDSv5Family' || name.value=='cores'].{quota:name.value, used:currentValue, limit:limit}" -o table   # need 6 free vCPUs
az aks get-versions --location "$LOCATION" -o table
az postgres flexible-server list-skus --location "$LOCATION" -o json | grep -c '"Standard_B2s"'   # non-zero = offered
az provider show --namespace Microsoft.Cache --query "resourceTypes[?resourceType=='redisEnterprise'].locations[]" -o tsv | grep -ix "East US 2"
```

## 3. Record the manual choices

1. Edit `infra/azure/parameters/dev.bicepparam`, or a copy pointed to by `INFRA_PARAMS`, and
   replace every `REPLACE_` value ([manual-choices.md](manual-choices.md)).
2. Never put a secret in the file; the validation in step 4 fails if one is there.
3. Generate the per-deployment PostgreSQL local admin password. It lives only in this shell:

```bash
export PP_PG_ADMIN_PASSWORD="$(openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-40)"
```

## 4. Validate (static, then read-only against Azure)

```bash
npm run validate:infra -- --self-test   # Bicep build/lint, parameters, naming, secret scan, template policy
npm run validate:infra -- --azure       # adds `az deployment sub validate` + `what-if`; creates nothing
```

Review the what-if output (path printed by the script). Expect only `Create` operations on a fresh
subscription.

## 5. Deploy — creates billable resources (authorization required)

```bash
DEPLOYMENT=pp-dev
az deployment sub create --name "$DEPLOYMENT" --location "$LOCATION" \
  --template-file infra/azure/main.bicep --parameters infra/azure/parameters/dev.bicepparam
```

- Expect 20–40 minutes; AKS, PostgreSQL and Azure Managed Redis are the slow parts.
- The deployment history contains no secret values: the admin password is a `securestring`, and
  the outputs are names, endpoints and identity IDs.

If AKS creation fails with an authorization error on the NAT gateway or virtual network:

- The control-plane identity holds Network Contributor on the AKS subnet only (least privilege).
- Grant the same role on the VNet, then re-run step 5:

```bash
az role assignment create --assignee-object-id "$(az identity show -g "$(az deployment sub show -n "$DEPLOYMENT" --query properties.outputs.resourceGroupName.value -o tsv)" -n id-pp-dev-aks-control-plane --query principalId -o tsv)" \
  --assignee-principal-type ServicePrincipal --role "Network Contributor" \
  --scope "$(az network vnet show -g "$(az deployment sub show -n "$DEPLOYMENT" --query properties.outputs.resourceGroupName.value -o tsv)" -n vnet-pp-dev --query id -o tsv)"
```

## 6. Read outputs and get cluster access

```bash
out() { az deployment sub show --name "$DEPLOYMENT" --query "properties.outputs.$1.value" -o tsv; }
RG=$(out resourceGroupName); AKS=$(out aksName); KV=$(out keyVaultName); PG_FQDN=$(out postgresFqdn)
az aks get-credentials --resource-group "$RG" --name "$AKS" --overwrite-existing
kubelogin convert-kubeconfig -l azurecli
kubectl create namespace portfolio-pilot
# GitHub deploy identity (only if githubRepository was set): Kubernetes write access to this namespace only.
GH_DEPLOY_OID=$(az deployment sub show -n "$DEPLOYMENT" --query "properties.outputs.githubIdentities.value[?environment=='production'].principalId | [0]" -o tsv)
[ -n "$GH_DEPLOY_OID" ] && az role assignment create --assignee-object-id "$GH_DEPLOY_OID" --assignee-principal-type ServicePrincipal \
  --role "Azure Kubernetes Service RBAC Writer" --scope "$(az aks show -g "$RG" -n "$AKS" --query id -o tsv)/namespaces/portfolio-pilot"
```

## 7. Bootstrap PostgreSQL roles and the database

- PostgreSQL is private, so `psql` runs in a short-lived pod inside the cluster.
- Each secret is the **first stdin line**; the SQL file follows. Nothing secret appears in the pod
  spec, the command line or the server log.
- The migrator password reaches the server only as a SCRAM verifier.
- The role model was verified locally with `npm run verify:postgres-roles` (14/14 on 2026-10-03).

```bash
OPERATOR_GROUP=pp-dev-operators   # exact display name of the Entra admin group (no spaces)
DATA_WORKLOADS="workload!='migrate' && workload!='otel' && workload!='tls'"   # runtime identities only
PRINCIPALS=$(az deployment sub show -n "$DEPLOYMENT" --query "properties.outputs.workloadIdentities.value[?$DATA_WORKLOADS].join('=', [identityName, principalId])" -o tsv | paste -sd, -)
RUNTIME_ROLES=$(az deployment sub show -n "$DEPLOYMENT" --query "properties.outputs.workloadIdentities.value[?$DATA_WORKLOADS].identityName" -o tsv | paste -sd, -)
pgpod() {  # $1 pod name, then extra --env flags; stdin = password line + SQL
  local name=$1; shift
  kubectl run "$name" -n portfolio-pilot --rm -i --quiet --restart=Never --image=postgres:17.6-alpine \
    --env="PGHOST=$PG_FQDN" --env=PGPORT=5432 --env=PGSSLMODE=verify-full --env=PGSSLROOTCERT=system "$@" \
    --command -- sh -c 'IFS= read -r PGPASSWORD && export PGPASSWORD && exec psql -X -v ON_ERROR_STOP=1 \
      ${PRINCIPALS:+-v principals="$PRINCIPALS"} ${VERIFIER:+-v migrator_verifier="$VERIFIER"} \
      ${RUNTIME_ROLES:+-v runtime_roles="$RUNTIME_ROLES"} -v database=portfolio_pilot -f -'
}

# Step 1 — as the Entra admin group (your own Entra token; group membership required).
{ az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv; cat infra/azure/sql/01-entra-principals.sql; } \
  | pgpod pg-bootstrap-1 --env=PGDATABASE=postgres --env="PGUSER=$OPERATOR_GROUP" --env="PRINCIPALS=$PRINCIPALS"

# Step 2 — as the local admin: runtime group, migration role (verifier only) and the database.
MIGRATOR_PASSWORD="$(openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-40)"
VERIFIER="$(printf '%s' "$MIGRATOR_PASSWORD" | node infra/azure/scripts/scram-verifier.mjs)"
{ printf '%s\n' "$PP_PG_ADMIN_PASSWORD"; cat infra/azure/sql/02-roles-and-database.sql; } \
  | pgpod pg-bootstrap-2 --env=PGDATABASE=postgres --env=PGUSER=ppbreakglass --env="VERIFIER=$VERIFIER" --env="RUNTIME_ROLES=$RUNTIME_ROLES"

# Step 3 — privileges inside the application database (re-run after the first migration).
{ printf '%s\n' "$PP_PG_ADMIN_PASSWORD"; cat infra/azure/sql/03-database-privileges.sql; } \
  | pgpod pg-bootstrap-3 --env=PGDATABASE=portfolio_pilot --env=PGUSER=ppbreakglass

# Migration URL for the milestone-35 migration Job (Prisma's own TLS parameters).
az keyvault secret set --vault-name "$KV" --name database-migrator-url --encoding utf-8 --output none \
  --file <(printf 'postgresql://pp_migrator:%s@%s:5432/portfolio_pilot?sslmode=require&sslaccept=strict' "$MIGRATOR_PASSWORD" "$PG_FQDN")
unset MIGRATOR_PASSWORD VERIFIER PP_PG_ADMIN_PASSWORD   # the local admin password is never stored
```

Runtime connection settings, non-secret, for the milestone-35 ConfigMaps (one per workload):

```text
DATABASE_AUTH=azure-workload-identity
DATABASE_URL=postgresql://<identityName>@<postgresFqdn>:5432/portfolio_pilot?sslmode=verify-full
REDIS_AUTH=azure-workload-identity
REDIS_URL=rediss://<redisHostName>:10000
REDIS_ENTRA_OBJECT_ID=<principalId of the same identity>
SESSION_ARTIFACT_BACKEND=azure            # agent worker only
SESSION_BLOB_CONTAINER_URL=<sessionBlobContainerUrl>
```

The workload identity webhook injects `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
`AZURE_FEDERATED_TOKEN_FILE` and `AZURE_AUTHORITY_HOST`.

## 8. Provider and application secrets (manual) with per-secret access

```bash
KV_ID=$(az keyvault show --name "$KV" --query id -o tsv)
ask() { local v; IFS= read -rs -p "$1: " v; echo; az keyvault secret set --vault-name "$KV" --name "$1" --encoding utf-8 --output none --file <(printf '%s' "$v"); unset v; }
gen() { az keyvault secret set --vault-name "$KV" --name "$1" --encoding utf-8 --output none --file <(openssl rand -base64 48 | tr -d '\n'); }
ask anthropic-api-key; ask alpaca-api-key; ask alpaca-api-secret; ask entra-client-secret
gen auth-secret; gen observability-actor-key
az keyvault secret set --vault-name "$KV" --name appinsights-connection-string --encoding utf-8 --output none \
  --file <(az monitor app-insights component show -g "$RG" -a "$(out appInsightsName)" --query connectionString -o tsv | tr -d '\n')

oid() { az deployment sub show -n "$DEPLOYMENT" --query "properties.outputs.workloadIdentities.value[?workload=='$1'].principalId | [0]" -o tsv; }
grant() { az role assignment create --assignee-object-id "$(oid "$1")" --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope "$KV_ID/secrets/$2" --output none; }
grant api auth-secret; grant api entra-client-secret; grant api observability-actor-key; grant api anthropic-api-key
grant ingestion alpaca-api-key; grant ingestion alpaca-api-secret; grant ingestion observability-actor-key
grant outbox observability-actor-key; grant outbox anthropic-api-key   # shared article analysis (milestone 35)
grant agent anthropic-api-key; grant agent observability-actor-key
grant migrate database-migrator-url
grant otel appinsights-connection-string
# Milestone 35: the gateway certificate (upload it first: docs/kubernetes/release-runbook.md step 0).
grant tls gateway-tls-crt; grant tls gateway-tls-key
```

## 9. Smoke tests (after milestone 35 manifests)

The Kubernetes release and its full smoke tests are in
[docs/kubernetes/release-runbook.md](../kubernetes/release-runbook.md). Step 0 there enables the app
routing Gateway API add-on (Azure CLI ≥ 2.86). The checks below are the Azure token-acceptance subset.


These are the live checks this milestone could not run. Each one exercises a real Azure token
acceptance path:

```bash
kubectl -n portfolio-pilot exec deploy/api -- node -e "fetch('http://127.0.0.1:3001/api/health/ready').then(r=>r.text()).then(console.log)"   # database + redis: true
kubectl -n portfolio-pilot logs deploy/agent-worker | grep -i 'reauthentication_failed' && echo 'Redis token refresh FAILED'   # run after > 1 h uptime
az postgres flexible-server show -g "$RG" -n "$(out postgresServerName)" --query "{state:state, auth:authConfig}" -o json
```

## 10. GitHub environments (only if `githubRepository` is set)

```bash
gh_id() { az deployment sub show -n "$DEPLOYMENT" --query "properties.outputs.githubIdentities.value[?environment=='$1'].clientId | [0]" -o tsv; }
for env in release-registry production; do
  gh variable set AZURE_CLIENT_ID --env "$env" --body "$(gh_id "$env")"
  gh variable set AZURE_TENANT_ID --env "$env" --body "$(out tenantId)"
  gh variable set AZURE_SUBSCRIPTION_ID --env "$env" --body "$(az account show --query id -o tsv)"
done
gh variable set ACR_NAME --env release-registry --body "$(out acrName)"
```

## Cleanup

> **Data-retention warnings — read before deleting.**
>
> - **PostgreSQL:** deleting the server deletes the database **and its automated backups**. Azure
>   documents a limited way to restore a *dropped* server; do not rely on it. Export first if
>   anything must survive.
> - **Azure Managed Redis:** persistence is disabled. All cached data and replayable event streams
>   are gone immediately. PostgreSQL remains the source of truth.
> - **Blob Storage:** deleting the account deletes all session artifacts. Blob soft delete
>   (`blobSoftDeleteDays`) protects individual blob deletions, not account deletion.
> - **Key Vault:** a deleted vault is *soft-deleted*. Its secrets stay recoverable and its name stays
>   reserved for `keyVaultSoftDeleteDays` (7 in dev). With purge protection enabled (production), it
>   **cannot** be purged early.
> - **Log Analytics:** a deleted workspace is soft-deleted and recoverable for a period, unless it is
>   force-deleted. Its logs (audit trails) go with it.
> - **Outside the resource group:** the operator group, the OIDC app registration and its client
>   secret, DNS records, GitHub variables and provider API keys survive deletion. Revoke or delete
>   them separately.

```bash
# 1. Optional export (plain SQL, via the migration role; secret is passed on stdin).
az keyvault secret show --vault-name "$KV" --name database-migrator-url --query value -o tsv \
  | kubectl run pg-dump -n portfolio-pilot --rm -i --quiet --restart=Never --image=postgres:17.6-alpine \
      --command -- sh -c 'IFS= read -r URL && exec pg_dump --format=plain --no-owner "${URL%%\?*}?sslmode=verify-full&sslrootcert=system"' \
  > "portfolio_pilot-$(date -u +%Y%m%dT%H%M%SZ).sql"

# 2. Optional: remove the Log Analytics workspace permanently instead of soft-deleting it.
az monitor log-analytics workspace delete --resource-group "$RG" --workspace-name log-pp-dev --force true --yes

# 3. Delete everything in the resource group (AKS also removes its node resource group).
az group delete --name "$RG" --yes
az deployment sub delete --name "$DEPLOYMENT"

# 4. Soft-deleted Key Vault: purge only if the secrets are definitely no longer needed (irreversible).
az keyvault list-deleted --query "[?name=='$KV'].{name:name, purgeAfter:properties.scheduledPurgeDate}" -o table
az keyvault purge --name "$KV" --location "$LOCATION"

# 5. Verify.
az group exists --name "$RG"                       # false
az group exists --name "rg-pp-dev-aks-nodes"       # false
```

Then, outside Azure resources:

1. Delete or rotate the OIDC app's client secret.
2. Revoke the Anthropic and Alpaca keys that were stored.
3. Remove the GitHub environment variables.
4. Delete the public DNS records.
