// Blob storage for protected Claude SDK session artifacts (milestone 28). Entra-only (shared keys
// and anonymous access disabled), private endpoint only. The agent worker identity gets data access
// on this one container. The lifecycle rule is a backstop behind the app's own 30-day cleanup.
param location string
param tags object
param accountName string
param containerName string
@minValue(1)
@maxValue(365)
param softDeleteDays int
@minValue(31)
@description('Must exceed the application retention (SESSION_RETENTION_DAYS = 30).')
param artifactExpiryDays int
param dataContributorPrincipalIds array
param subnetId string
param privateDnsZoneId string
param logAnalyticsWorkspaceId string

var blobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource account 'Microsoft.Storage/storageAccounts@2025-06-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    allowCrossTenantReplication: false
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None' }
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' = {
  parent: account
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: softDeleteDays }
    containerDeleteRetentionPolicy: { enabled: true, days: softDeleteDays }
  }
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = {
  parent: blobs
  name: containerName
  properties: { publicAccess: 'None' }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2025-06-01' = {
  parent: account
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-session-artifacts'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['${containerName}/sessions/'] }
            actions: { baseBlob: { delete: { daysAfterCreationGreaterThan: artifactExpiryDays } } }
          }
        }
      ]
    }
  }
}

resource dataAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in dataContributorPrincipalIds: {
  name: guid(container.id, principalId, blobDataContributor)
  scope: container
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
  }
}]

module endpoint 'private-endpoint.bicep' = {
  name: 'pe-blob'
  params: {
    location: location
    tags: tags
    name: 'pe-${account.name}-blob'
    subnetId: subnetId
    serviceId: account.id
    groupId: 'blob'
    privateDnsZoneId: privateDnsZoneId
  }
}

// The newest diagnostic-settings API with category groups is this preview; the GA 2016-09-01 lacks them.
#disable-next-line use-recent-api-versions
resource audit 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'audit-to-log-analytics'
  scope: blobs
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [{ categoryGroup: 'audit', enabled: true }]
  }
}

output accountName string = account.name
output containerUrl string = '${account.properties.primaryEndpoints.blob}${containerName}'
