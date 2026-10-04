// Key Vault for provider and application secrets (RBAC authorization, no access policies).
// Pods read through the private endpoint with the Secrets Store CSI driver; operators write from
// the allowed public IPs. This template creates no secret values (docs/azure/credentials.md).
param location string
param tags object
param baseName string
param nameSuffix string
@minValue(7)
@maxValue(90)
@description('Fixed at creation. Deleted vaults keep their name reserved for this many days.')
param softDeleteRetentionDays int
@description('Irreversible once enabled: the vault and its secrets cannot be purged before retention ends.')
param purgeProtection bool
@description('Operator public CIDRs allowed through the firewall. Empty disables public access entirely.')
param operatorIpRanges array
param operatorGroupObjectId string
param subnetId string
param privateDnsZoneId string
param logAnalyticsWorkspaceId string

var secretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource vault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: 'kv-${baseName}-${nameSuffix}'
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionDays
    // The service rejects an explicit false; omit the property unless enabling.
    enablePurgeProtection: purgeProtection ? true : null
    publicNetworkAccess: empty(operatorIpRanges) ? 'Disabled' : 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      ipRules: [for range in operatorIpRanges: { value: range }]
    }
  }
}

// Operators set provider secrets; workloads get per-secret reader roles (docs/azure/provisioning.md).
resource operators 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, operatorGroupObjectId, secretsOfficer)
  scope: vault
  properties: {
    principalId: operatorGroupObjectId
    principalType: 'Group'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsOfficer)
  }
}

module endpoint 'private-endpoint.bicep' = {
  name: 'pe-keyvault'
  params: {
    location: location
    tags: tags
    name: 'pe-${vault.name}'
    subnetId: subnetId
    serviceId: vault.id
    groupId: 'vault'
    privateDnsZoneId: privateDnsZoneId
  }
}

// The newest diagnostic-settings API with category groups is this preview; the GA 2016-09-01 lacks them.
#disable-next-line use-recent-api-versions
resource audit 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'audit-to-log-analytics'
  scope: vault
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [{ categoryGroup: 'audit', enabled: true }]
  }
}

output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
