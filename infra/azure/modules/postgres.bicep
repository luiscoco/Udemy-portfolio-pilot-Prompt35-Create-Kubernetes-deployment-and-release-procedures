// PostgreSQL Flexible Server, reachable only through its private endpoint.
// - Runtime identities sign in with Entra tokens (roles created by sql/bootstrap-roles.sql).
// - Password authentication remains for the migration role, whose password lives in Key Vault.
// - The application database is created by sql/02-roles-and-database.sql so that the migration
//   role owns it (ownership of an ARM-created database is not under our control).
// - The local administrator password is a deploy-time secure parameter that is never stored;
//   break-glass access is through the Entra administrator group (docs/azure/credentials.md).
param location string
param tags object
param baseName string
param nameSuffix string
param skuName string
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param skuTier string
@allowed(['16', '17'])
param version string
@minValue(32)
param storageSizeGb int
@minValue(7)
@maxValue(35)
param backupRetentionDays int
@allowed(['Disabled', 'Enabled'])
@description('Fixed at creation: changing it later requires a new server.')
param geoRedundantBackup string
@allowed(['Disabled', 'SameZone', 'ZoneRedundant'])
param highAvailability string
param administratorLogin string
@secure()
param administratorPassword string
param entraAdminObjectId string
param entraAdminName string
@allowed(['Group', 'User', 'ServicePrincipal'])
param entraAdminType string
param subnetId string
param privateDnsZoneId string
param logAnalyticsWorkspaceId string

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: 'psql-${baseName}-${nameSuffix}'
  location: location
  tags: tags
  sku: { name: skuName, tier: skuTier }
  properties: {
    version: version
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Enabled'
      tenantId: tenant().tenantId
    }
    storage: {
      storageSizeGB: storageSizeGb
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup
    }
    highAvailability: { mode: highAvailability }
    network: { publicNetworkAccess: 'Disabled' }
    maintenanceWindow: {
      customWindow: 'Enabled'
      dayOfWeek: 0
      startHour: 3
      startMinute: 0
    }
  }
}

resource entraAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = {
  parent: server
  name: entraAdminObjectId
  properties: {
    principalType: entraAdminType
    principalName: entraAdminName
    tenantId: tenant().tenantId
  }
}

module endpoint 'private-endpoint.bicep' = {
  name: 'pe-postgres'
  params: {
    location: location
    tags: tags
    name: 'pe-${server.name}'
    subnetId: subnetId
    serviceId: server.id
    groupId: 'postgresqlServer'
    privateDnsZoneId: privateDnsZoneId
  }
  dependsOn: [entraAdmin]
}

// The newest diagnostic-settings API with category groups is this preview; the GA 2016-09-01 lacks them.
#disable-next-line use-recent-api-versions
resource logs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'logs-to-log-analytics'
  scope: server
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [{ category: 'PostgreSQLLogs', enabled: true }]
  }
}

output serverName string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
