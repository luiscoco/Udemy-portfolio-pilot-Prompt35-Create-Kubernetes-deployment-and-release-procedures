// Small development environment. Contains no secrets: the PostgreSQL local admin password is read
// from the PP_PG_ADMIN_PASSWORD environment variable at deployment time and never stored.
// Every REPLACE_ value is a manual choice (docs/azure/manual-choices.md); `npm run validate:infra`
// accepts the placeholders, but a deployment with them fails before creating anything.
using '../main.bicep'

param location = 'eastus2'
param resourceGroupName = 'rg-pp-dev-eastus2'
param environmentName = 'dev'
param workloadName = 'pp'
param owner = 'REPLACE_owner_alias'
param costCenter = 'REPLACE_cost_center'
param extraTags = {
  dataClassification: 'confidential'
  lifecycle: 'disposable-dev'
}

// Entra group for operators (object ID GUID and exact display name).
param operatorGroupObjectId = 'REPLACE_00000000-0000-0000-0000-000000000000'
param operatorGroupName = 'REPLACE_pp-dev-operators'
// Your public IP as a /32 (curl -s https://api.ipify.org). Used for Key Vault and the AKS API server.
param operatorIpRanges = []
param aksAuthorizedIpRanges = []

// Smallest sizes the workload fits (docs/azure/cost-estimate.md).
param aksTier = 'Free'
// Milestone 35: pinned minor (AKS picks its latest GA patch). It decides the managed Gateway API bundle
// (1.35 -> v1.4.1 standard channel) and the app routing Istio minor that deploy/kubernetes was tested with.
param kubernetesVersion = '1.35'
// Dsv6 instead of Dsv5: new subscriptions can have 0 vCPU quota for older families. Check yours with
// the quota command in docs/azure/provisioning.md step 2 and pick a size whose family has quota.
param aksNodeVmSize = 'Standard_D2s_v6'
param aksNodeMinCount = 2
param aksNodeMaxCount = 3
param acrSku = 'Basic'
param postgresSkuName = 'Standard_B2s'
param postgresSkuTier = 'Burstable'
param postgresStorageGb = 32
param postgresBackupRetentionDays = 7
param postgresGeoRedundantBackup = 'Disabled'
param postgresHighAvailability = 'Disabled'
param redisSkuName = 'Balanced_B0'
param redisHighAvailability = 'Disabled'
param redisAccessKeysAuthentication = 'Disabled'
param keyVaultSoftDeleteDays = 7
param keyVaultPurgeProtection = false
param blobSoftDeleteDays = 7
param sessionArtifactExpiryDays = 31
param logRetentionDays = 30
param logDailyCapGb = 1

param githubRepository = ''
// docs/azure/cost-estimate.md estimates about USD 330-370 per month at these sizes.
param budgetMonthlyAmount = 400
param budgetContactEmails = ['REPLACE_you@example.com']

param postgresAdministratorPassword = readEnvironmentVariable('PP_PG_ADMIN_PASSWORD')
