// Everything inside the PortfolioPilot resource group. See docs/azure/ for the network design,
// identity/credential model, cost worksheet and provisioning/cleanup runbook.
param location string
param tags object
param workloadName string
param environmentName string
param vnetAddressPrefix string
param aksSubnetPrefix string
param privateEndpointSubnetPrefix string
param podCidr string
param serviceCidr string
param dnsServiceIp string
param natIdleTimeoutMinutes int
param kubernetesVersion string
param aksTier string
param aksNodeVmSize string
param aksNodeMinCount int
param aksNodeMaxCount int
param aksAvailabilityZones array
param aksAuthorizedIpRanges array
param kubernetesNamespace string
param operatorGroupObjectId string
param operatorGroupName string
param operatorIpRanges array
param acrSku string
param postgresSkuName string
param postgresSkuTier string
param postgresVersion string
param postgresStorageGb int
param postgresBackupRetentionDays int
param postgresGeoRedundantBackup string
param postgresHighAvailability string
param postgresAdministratorLogin string
@secure()
param postgresAdministratorPassword string
param redisSkuName string
param redisHighAvailability string
param redisAccessKeysAuthentication string
param redisEvictionPolicy string
param keyVaultSoftDeleteDays int
param keyVaultPurgeProtection bool
param blobSoftDeleteDays int
param sessionArtifactExpiryDays int
param logRetentionDays int
param logDailyCapGb int
param githubRepository string
param budgetMonthlyAmount int
param budgetContactEmails array
param budgetStartDate string

var baseName = '${workloadName}-${environmentName}'
// Globally unique names (registry, server, cache, vault, storage) share a stable 6-character suffix.
var suffix = take(uniqueString(subscription().id, resourceGroup().id, baseName), 6)
var compact = '${workloadName}${environmentName}${suffix}'
var databaseName = 'portfolio_pilot'
var sessionContainer = 'session-artifacts'

var roles = {
  acrPush: '8311e382-0749-4cb8-b61a-304f252e45ec'
  aksClusterUser: '4abbcc35-e782-43d8-92c5-2d3f1bd2253f'
  aksRbacClusterAdmin: 'b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b'
  monitoringMetricsPublisher: '3913510d-42f4-4e42-8a64-420c390055eb'
}

// One identity per workload so each gets only its own permissions. Milestone 35 must create these
// Kubernetes service accounts in `kubernetesNamespace` with the matching client-id annotation.
// The first four sign in to PostgreSQL and Redis with Entra tokens; indexes below rely on this order.
var workloads = [
  { key: 'api', serviceAccount: 'pp-api' }
  { key: 'ingestion', serviceAccount: 'pp-ingestion' }
  { key: 'outbox', serviceAccount: 'pp-outbox' }
  { key: 'agent', serviceAccount: 'pp-agent' }
  { key: 'migrate', serviceAccount: 'pp-migrate' }
  { key: 'otel', serviceAccount: 'pp-otel-collector' }
  // Milestone 35: reads only the gateway TLS certificate (per-secret grant) for the HTTPS listener.
  { key: 'tls', serviceAccount: 'pp-tls-sync' }
]
var dataWorkloadCount = 4
var agentIndex = 3
var otelIndex = 5
var githubEnvironments = empty(githubRepository) ? [] : [
  { key: 'gh-registry', environment: 'release-registry' }
  { key: 'gh-deploy', environment: 'production' }
]

module network 'network.bicep' = {
  name: 'network'
  params: {
    location: location
    tags: tags
    baseName: baseName
    vnetAddressPrefix: vnetAddressPrefix
    aksSubnetPrefix: aksSubnetPrefix
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix
    natIdleTimeoutMinutes: natIdleTimeoutMinutes
  }
}

module monitoring 'monitoring.bicep' = {
  name: 'monitoring'
  params: {
    location: location
    tags: tags
    baseName: baseName
    retentionDays: logRetentionDays
    dailyCapGb: logDailyCapGb
  }
}

resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = [for w in workloads: {
  name: 'id-${baseName}-${w.key}'
  location: location
  tags: tags
}]

resource githubIdentities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = [for g in githubEnvironments: {
  name: 'id-${baseName}-${g.key}'
  location: location
  tags: tags
}]

module registry 'registry.bicep' = {
  name: 'registry'
  params: {
    location: location
    tags: tags
    name: 'acr${compact}'
    sku: acrSku
  }
}

module aks 'aks.bicep' = {
  name: 'aks'
  params: {
    location: location
    tags: tags
    baseName: baseName
    vnetName: 'vnet-${baseName}'
    aksSubnetName: 'snet-aks-nodes'
    natPublicIp: network.outputs.natPublicIp
    kubernetesVersion: kubernetesVersion
    tier: aksTier
    nodeVmSize: aksNodeVmSize
    nodeMinCount: aksNodeMinCount
    nodeMaxCount: aksNodeMaxCount
    availabilityZones: aksAvailabilityZones
    podCidr: podCidr
    serviceCidr: serviceCidr
    dnsServiceIp: dnsServiceIp
    authorizedIpRanges: aksAuthorizedIpRanges
    logAnalyticsWorkspaceId: monitoring.outputs.workspaceId
    containerInsightsRuleId: monitoring.outputs.containerInsightsRuleId
    acrName: registry.outputs.name
  }
}

module federation 'federation.bicep' = {
  name: 'federation'
  params: {
    kubernetesCredentials: [for w in workloads: { identityName: 'id-${baseName}-${w.key}', serviceAccount: w.serviceAccount }]
    kubernetesNamespace: kubernetesNamespace
    aksOidcIssuerUrl: aks.outputs.oidcIssuerUrl
    githubCredentials: [for g in githubEnvironments: { identityName: 'id-${baseName}-${g.key}', environment: g.environment }]
    githubRepository: githubRepository
  }
  dependsOn: [identities, githubIdentities]
}

module postgres 'postgres.bicep' = {
  name: 'postgres'
  params: {
    location: location
    tags: tags
    baseName: baseName
    nameSuffix: suffix
    skuName: postgresSkuName
    skuTier: postgresSkuTier
    version: postgresVersion
    storageSizeGb: postgresStorageGb
    backupRetentionDays: postgresBackupRetentionDays
    geoRedundantBackup: postgresGeoRedundantBackup
    highAvailability: postgresHighAvailability
    administratorLogin: postgresAdministratorLogin
    administratorPassword: postgresAdministratorPassword
    entraAdminObjectId: operatorGroupObjectId
    entraAdminName: operatorGroupName
    entraAdminType: 'Group'
    subnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneId: network.outputs.privateDnsZoneIds.postgres
    logAnalyticsWorkspaceId: monitoring.outputs.workspaceId
  }
}

module redis 'redis.bicep' = {
  name: 'redis'
  params: {
    location: location
    tags: tags
    baseName: baseName
    nameSuffix: suffix
    skuName: redisSkuName
    highAvailability: redisHighAvailability
    accessKeysAuthentication: redisAccessKeysAuthentication
    evictionPolicy: redisEvictionPolicy
    entraUsers: [for i in range(0, dataWorkloadCount): { name: workloads[i].key, principalId: identities[i].properties.principalId }]
    subnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneId: network.outputs.privateDnsZoneIds.redis
  }
}

module keyVault 'keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    tags: tags
    baseName: baseName
    nameSuffix: suffix
    softDeleteRetentionDays: keyVaultSoftDeleteDays
    purgeProtection: keyVaultPurgeProtection
    operatorIpRanges: operatorIpRanges
    operatorGroupObjectId: operatorGroupObjectId
    subnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneId: network.outputs.privateDnsZoneIds.keyVault
    logAnalyticsWorkspaceId: monitoring.outputs.workspaceId
  }
}

module storage 'storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    tags: tags
    accountName: 'st${compact}'
    containerName: sessionContainer
    softDeleteDays: blobSoftDeleteDays
    artifactExpiryDays: sessionArtifactExpiryDays
    // Only the agent worker reads and writes SDK session snapshots.
    dataContributorPrincipalIds: [identities[agentIndex].properties.principalId]
    subnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneId: network.outputs.privateDnsZoneIds.blob
    logAnalyticsWorkspaceId: monitoring.outputs.workspaceId
  }
}

resource cluster 'Microsoft.ContainerService/managedClusters@2025-10-01' existing = {
  name: 'aks-${baseName}'
  dependsOn: [aks]
}
resource acr 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: 'acr${compact}'
  dependsOn: [registry]
}
resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: 'appi-${baseName}'
  dependsOn: [monitoring]
}

// Operators: cluster administration through Entra (local accounts are disabled).
resource operatorClusterUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(cluster.id, operatorGroupObjectId, roles.aksClusterUser)
  scope: cluster
  properties: {
    principalId: operatorGroupObjectId
    principalType: 'Group'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.aksClusterUser)
  }
}
resource operatorClusterAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(cluster.id, operatorGroupObjectId, roles.aksRbacClusterAdmin)
  scope: cluster
  properties: {
    principalId: operatorGroupObjectId
    principalType: 'Group'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.aksRbacClusterAdmin)
  }
}

// The collector may publish telemetry with Entra auth once that exporter path is verified.
resource otelPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appInsights.id, identities[otelIndex].id, roles.monitoringMetricsPublisher)
  scope: appInsights
  properties: {
    principalId: identities[otelIndex].properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.monitoringMetricsPublisher)
  }
}

// GitHub release: push images only; deploy: fetch cluster credentials only (namespace-scoped
// Kubernetes permissions are granted by a provisioning command, docs/azure/provisioning.md).
resource githubPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(githubRepository)) {
  name: guid(acr.id, 'gh-registry', roles.acrPush)
  scope: acr
  properties: {
    principalId: empty(githubRepository) ? '' : githubIdentities[0].properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPush)
  }
}
resource githubClusterUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(githubRepository)) {
  name: guid(cluster.id, 'gh-deploy', roles.aksClusterUser)
  scope: cluster
  properties: {
    principalId: empty(githubRepository) ? '' : githubIdentities[1].properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.aksClusterUser)
  }
}

module budget 'budget.bicep' = if (budgetMonthlyAmount > 0) {
  name: 'budget'
  params: {
    name: 'budget-${baseName}'
    amount: budgetMonthlyAmount
    startDate: budgetStartDate
    contactEmails: budgetContactEmails
  }
}

// Names, endpoints and identity IDs only; no secret values (outputs-should-not-contain-secrets).
output aksName string = aks.outputs.clusterName
output aksOidcIssuerUrl string = aks.outputs.oidcIssuerUrl
output acrLoginServer string = registry.outputs.loginServer
output acrName string = registry.outputs.name
output natPublicIp string = network.outputs.natPublicIp
output postgresServerName string = postgres.outputs.serverName
output postgresFqdn string = postgres.outputs.fqdn
output postgresDatabase string = databaseName
output redisName string = redis.outputs.clusterName
output redisHostName string = redis.outputs.hostName
output redisPort int = redis.outputs.port
output keyVaultName string = keyVault.outputs.vaultName
output keyVaultUri string = keyVault.outputs.vaultUri
output storageAccountName string = storage.outputs.accountName
output sessionBlobContainerUrl string = storage.outputs.containerUrl
output appInsightsName string = monitoring.outputs.appInsightsName
output kubernetesNamespace string = kubernetesNamespace
output tenantId string = tenant().tenantId
output workloadIdentities array = [for (w, i) in workloads: {
  workload: w.key
  serviceAccount: w.serviceAccount
  identityName: identities[i].name
  clientId: identities[i].properties.clientId
  principalId: identities[i].properties.principalId
}]
output githubIdentities array = [for (g, i) in githubEnvironments: {
  environment: g.environment
  identityName: githubIdentities[i].name
  clientId: githubIdentities[i].properties.clientId
  principalId: githubIdentities[i].properties.principalId
}]
