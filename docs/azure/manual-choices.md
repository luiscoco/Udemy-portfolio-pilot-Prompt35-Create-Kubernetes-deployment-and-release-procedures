# Manual choices before provisioning (milestone 34)

The template cannot make these decisions. Each one maps to a `REPLACE_` placeholder or a
parameter in `infra/azure/parameters/dev.bicepparam`, or to a step in
[provisioning.md](provisioning.md). `npm run validate:infra` lists the placeholders still open.
A deployment refuses to proceed while they remain.

| Choice | Where it goes | How to decide / find it |
| --- | --- | --- |
| **Subscription** | `az account set --subscription <id>` | One you are allowed to spend on. Deploying needs **Owner** (or Contributor + User Access Administrator), because the template creates role assignments. |
| **Region** | `location` | Must offer AKS, `Standard_D2s_v6` (or another 2-vCPU size) with family quota for at least 3 nodes (6 vCPU), PostgreSQL Flexible Server `Standard_B2s`, and Azure Managed Redis. The preflight checks are in provisioning step 2. Template default: `eastus2` (all meters priced there on 2026-10-03; capacity and quota are not guaranteed). |
| **Resource group** | `resourceGroupName` | A new, dedicated group (cleanup deletes the whole group). AKS also creates `rg-<workload>-<env>-aks-nodes`; that name must be free. |
| **Workload and environment names** | `workloadName` (2–6 lowercase letters/digits), `environmentName` (`dev`/`test`/`prod`) | They appear in every name. The registry, storage, Key Vault, server and cache names add a 6-character `uniqueString` suffix for global uniqueness. |
| **Tags** | `owner`, `costCenter`, `extraTags` | Used for cost reports and cleanup. `application`, `environment`, `managedBy` and `repository` are added automatically. |
| **Operator Entra group** | `operatorGroupObjectId`, `operatorGroupName` | Create a security group (for example `pp-dev-operators`, **no spaces**) with the people who operate this environment. Members become AKS cluster admins, Key Vault secrets officers and the PostgreSQL Entra administrator. `az ad group show --group pp-dev-operators --query id -o tsv`. |
| **Operator IPs** | `operatorIpRanges`, `aksAuthorizedIpRanges` | Your public IP as `/32` (`curl -s https://api.ipify.org`). Key Vault is otherwise closed to the internet, which blocks setting secrets from a laptop. Leaving `aksAuthorizedIpRanges` empty keeps the API server reachable from anywhere (Entra RBAC still required). |
| **DNS / public host** | `AUTH_BASE_URL` and the gateway (milestone 35) | A domain you control, for example `pp-dev.example.com`. You need a DNS zone (Azure DNS or your registrar) to point at the milestone-35 ingress IP, and a TLS certificate (cert-manager with ACME, or Key Vault). No public host is created in milestone 34. |
| **OIDC app (user sign-in)** | Key Vault secret `entra-client-secret`; `ENTRA_CLIENT_ID`/`ENTRA_TENANT_ID` as configuration | A confidential **Web** app registration in your tenant (ADR 0003, lesson 07), with redirect URI `https://<public host>/api/auth/callback/microsoft` and the optional `email` ID-token claim. Create the client secret in the portal and store it with the provisioning commands. Prefer a short expiry and track its renewal date. |
| **Provider secrets** | Key Vault secrets `anthropic-api-key`, `alpaca-api-key`, `alpaca-api-secret` | Anthropic Console API key, with a spend limit set on the Anthropic side, and Alpaca market-data keys. Each is entered interactively; nothing is written to files or shell history. |
| **Application secrets** | `auth-secret`, `observability-actor-key` | Generated with `openssl rand -base64 48` during provisioning. |
| **Budget** | `budgetMonthlyAmount`, `budgetContactEmails` | Dev default: 400 (USD, or your billing currency). [cost-estimate.md](cost-estimate.md) estimates ≈334–370/month. The emails receive the 80%/100% actual and 100% forecast alerts. |
| **GitHub repository** | `githubRepository` (`owner/repo`) | Enables federated credentials for GitHub environments `release-registry` (AcrPush) and `production` (deploy). Leave empty until the repository exists (milestone 33 follow-up). |
| **Durability trade-offs** | `postgresGeoRedundantBackup`, `postgresHighAvailability`, `redisHighAvailability`, `keyVaultPurgeProtection`, `keyVaultSoftDeleteDays` | Dev defaults favour cost and easy cleanup. **Geo-redundant backup and Key Vault soft-delete retention are fixed at creation, and purge protection cannot be turned off.** For production, enable zone-redundant HA, geo-redundant backup, Redis HA and purge protection, and use AKS Standard tier. |
| **Kubernetes version** | `kubernetesVersion` | Empty uses the region default. `az aks get-versions -l <region> -o table`; the auto-upgrade channel is `patch`. |
