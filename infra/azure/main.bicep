// PortfolioPilot Azure infrastructure (milestone 34). Subscription-scoped so one deployment (and one
// what-if) covers the resource group and everything in it. Nothing here holds a secret value:
// the only secure input is the never-stored PostgreSQL local admin password (docs/azure/credentials.md).
targetScope = 'subscription'

@description('Azure region. Manual choice: confirm SKU availability and quota first (docs/azure/provisioning.md).')
param location string
@description('Manual choice: the resource group to create or reuse.')
@minLength(1)
@maxLength(90)
param resourceGroupName string
@allowed(['dev', 'test', 'prod'])
param environmentName string
@description('Lowercase letters and digits; appears in every name, including globally unique ones.')
@minLength(2)
@maxLength(6)
param workloadName string = 'pp'
@description('Required tags: owner and costCenter; extra tags are merged in.')
param owner string
param costCenter string
param extraTags object = {}

// Network.
param vnetAddressPrefix string = '10.40.0.0/16'
param aksSubnetPrefix string = '10.40.0.0/22'
param privateEndpointSubnetPrefix string = '10.40.8.0/24'
@description('Overlay pod range; must not overlap the VNet or anything it peers with.')
param podCidr string = '10.244.0.0/16'
param serviceCidr string = '10.41.0.0/16'
param dnsServiceIp string = '10.41.0.10'
param natIdleTimeoutMinutes int = 10

// AKS.
param kubernetesVersion string = ''
@allowed(['Free', 'Standard'])
param aksTier string = 'Free'
param aksNodeVmSize string = 'Standard_D2s_v6'
@minValue(1)
param aksNodeMinCount int = 2
@minValue(1)
param aksNodeMaxCount int = 3
param aksAvailabilityZones array = []
@description('Operator CIDRs for the AKS API server; the NAT egress IP is added automatically.')
param aksAuthorizedIpRanges array = []
param kubernetesNamespace string = 'portfolio-pilot'

@description('Manual choice: Entra group (object ID) for operators: AKS admin, Key Vault secrets officer, PostgreSQL Entra admin.')
param operatorGroupObjectId string
@description('Display name of that group; PostgreSQL maps the Entra admin role by this exact name.')
param operatorGroupName string
@description('Operator public CIDRs for Key Vault secret management. Empty closes Key Vault to the internet.')
param operatorIpRanges array = []

@allowed(['Basic', 'Standard', 'Premium'])
param acrSku string = 'Basic'

// PostgreSQL Flexible Server.
param postgresSkuName string = 'Standard_B2s'
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param postgresSkuTier string = 'Burstable'
@allowed(['16', '17'])
param postgresVersion string = '17'
@minValue(32)
param postgresStorageGb int = 32
@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int = 7
@allowed(['Disabled', 'Enabled'])
param postgresGeoRedundantBackup string = 'Disabled'
@allowed(['Disabled', 'SameZone', 'ZoneRedundant'])
param postgresHighAvailability string = 'Disabled'
param postgresAdministratorLogin string = 'ppbreakglass'
@secure()
@minLength(16)
@description('Generated per deployment and never stored; supply from an environment variable, never a file.')
param postgresAdministratorPassword string

// Azure Managed Redis.
param redisSkuName string = 'Balanced_B0'
@allowed(['Disabled', 'Enabled'])
param redisHighAvailability string = 'Disabled'
@allowed(['Disabled', 'Enabled'])
param redisAccessKeysAuthentication string = 'Disabled'
@allowed(['NoEviction', 'VolatileLRU', 'AllKeysLRU'])
param redisEvictionPolicy string = 'NoEviction'

// Key Vault and storage.
@minValue(7)
@maxValue(90)
param keyVaultSoftDeleteDays int = 7
param keyVaultPurgeProtection bool = false
@minValue(1)
@maxValue(365)
param blobSoftDeleteDays int = 7
@minValue(31)
param sessionArtifactExpiryDays int = 31

// Monitoring.
@minValue(30)
@maxValue(730)
param logRetentionDays int = 30
param logDailyCapGb int = 1

@description('Manual choice: owner/repository for GitHub OIDC release identities. Empty skips them.')
param githubRepository string = ''

@description('Manual choice: monthly budget in the billing currency. 0 skips the budget.')
@minValue(0)
param budgetMonthlyAmount int = 0
param budgetContactEmails array = []
param budgetStartDate string = '${utcNow('yyyy-MM')}-01'

var tags = union({
  application: 'portfolio-pilot'
  environment: environmentName
  owner: owner
  costCenter: costCenter
  managedBy: 'bicep'
  repository: empty(githubRepository) ? 'unset' : githubRepository
}, extraTags)

resource group 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module workload 'modules/workload.bicep' = {
  name: 'portfolio-pilot-${environmentName}'
  scope: group
  params: {
    location: location
    tags: tags
    workloadName: toLower(workloadName)
    environmentName: environmentName
    vnetAddressPrefix: vnetAddressPrefix
    aksSubnetPrefix: aksSubnetPrefix
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix
    podCidr: podCidr
    serviceCidr: serviceCidr
    dnsServiceIp: dnsServiceIp
    natIdleTimeoutMinutes: natIdleTimeoutMinutes
    kubernetesVersion: kubernetesVersion
    aksTier: aksTier
    aksNodeVmSize: aksNodeVmSize
    aksNodeMinCount: aksNodeMinCount
    aksNodeMaxCount: aksNodeMaxCount
    aksAvailabilityZones: aksAvailabilityZones
    aksAuthorizedIpRanges: aksAuthorizedIpRanges
    kubernetesNamespace: kubernetesNamespace
    operatorGroupObjectId: operatorGroupObjectId
    operatorGroupName: operatorGroupName
    operatorIpRanges: operatorIpRanges
    acrSku: acrSku
    postgresSkuName: postgresSkuName
    postgresSkuTier: postgresSkuTier
    postgresVersion: postgresVersion
    postgresStorageGb: postgresStorageGb
    postgresBackupRetentionDays: postgresBackupRetentionDays
    postgresGeoRedundantBackup: postgresGeoRedundantBackup
    postgresHighAvailability: postgresHighAvailability
    postgresAdministratorLogin: postgresAdministratorLogin
    postgresAdministratorPassword: postgresAdministratorPassword
    redisSkuName: redisSkuName
    redisHighAvailability: redisHighAvailability
    redisAccessKeysAuthentication: redisAccessKeysAuthentication
    redisEvictionPolicy: redisEvictionPolicy
    keyVaultSoftDeleteDays: keyVaultSoftDeleteDays
    keyVaultPurgeProtection: keyVaultPurgeProtection
    blobSoftDeleteDays: blobSoftDeleteDays
    sessionArtifactExpiryDays: sessionArtifactExpiryDays
    logRetentionDays: logRetentionDays
    logDailyCapGb: logDailyCapGb
    githubRepository: githubRepository
    budgetMonthlyAmount: budgetMonthlyAmount
    budgetContactEmails: budgetContactEmails
    budgetStartDate: budgetStartDate
  }
}

output resourceGroupName string = group.name
output aksName string = workload.outputs.aksName
output aksOidcIssuerUrl string = workload.outputs.aksOidcIssuerUrl
output acrLoginServer string = workload.outputs.acrLoginServer
output acrName string = workload.outputs.acrName
output natPublicIp string = workload.outputs.natPublicIp
output postgresServerName string = workload.outputs.postgresServerName
output postgresFqdn string = workload.outputs.postgresFqdn
output postgresDatabase string = workload.outputs.postgresDatabase
output redisName string = workload.outputs.redisName
output redisHostName string = workload.outputs.redisHostName
output redisPort int = workload.outputs.redisPort
output keyVaultName string = workload.outputs.keyVaultName
output keyVaultUri string = workload.outputs.keyVaultUri
output storageAccountName string = workload.outputs.storageAccountName
output sessionBlobContainerUrl string = workload.outputs.sessionBlobContainerUrl
output appInsightsName string = workload.outputs.appInsightsName
output kubernetesNamespace string = workload.outputs.kubernetesNamespace
output tenantId string = workload.outputs.tenantId
output workloadIdentities array = workload.outputs.workloadIdentities
output githubIdentities array = workload.outputs.githubIdentities
