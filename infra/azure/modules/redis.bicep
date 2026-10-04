// Azure Managed Redis (Microsoft.Cache/redisEnterprise), TLS only, private endpoint only.
// Clustering policy EnterpriseCluster exposes one proxy endpoint, so the existing non-cluster
// node-redis client works; every application command touches a single key (docs/azure/credentials.md).
// Access keys are disabled: each runtime identity is an Entra user of the database.
param location string
param tags object
param baseName string
param nameSuffix string
param skuName string
@allowed(['Disabled', 'Enabled'])
@description('Disabled has no replica and no SLA; it cannot be turned off again once enabled.')
param highAvailability string
@allowed(['Disabled', 'Enabled'])
param accessKeysAuthentication string
@allowed(['NoEviction', 'VolatileLRU', 'AllKeysLRU'])
param evictionPolicy string
@description('Runtime identities: { name: alphanumeric assignment name, principalId: object ID }.')
param entraUsers array
param subnetId string
param privateDnsZoneId string

resource cluster 'Microsoft.Cache/redisEnterprise@2025-07-01' = {
  name: 'amr-${baseName}-${nameSuffix}'
  location: location
  tags: tags
  sku: { name: skuName }
  properties: {
    minimumTlsVersion: '1.2'
    highAvailability: highAvailability
    publicNetworkAccess: 'Disabled'
    encryption: {}
  }
}

resource database 'Microsoft.Cache/redisEnterprise/databases@2025-07-01' = {
  parent: cluster
  name: 'default'
  properties: {
    clientProtocol: 'Encrypted'
    port: 10000
    clusteringPolicy: 'EnterpriseCluster'
    evictionPolicy: evictionPolicy
    accessKeysAuthentication: accessKeysAuthentication
    // Redis holds caches, replayable streams and coordination only; PostgreSQL is authoritative.
    persistence: { aofEnabled: false, rdbEnabled: false }
    modules: []
  }
}

// The cache serializes control-plane operations, so assignments are created one at a time.
@batchSize(1)
resource users 'Microsoft.Cache/redisEnterprise/databases/accessPolicyAssignments@2025-07-01' = [for user in entraUsers: {
  parent: database
  name: user.name
  properties: {
    accessPolicyName: 'default'
    user: { objectId: user.principalId }
  }
}]

module endpoint 'private-endpoint.bicep' = {
  name: 'pe-redis'
  params: {
    location: location
    tags: tags
    name: 'pe-${cluster.name}'
    subnetId: subnetId
    serviceId: cluster.id
    groupId: 'redisEnterprise'
    privateDnsZoneId: privateDnsZoneId
  }
  dependsOn: [users]
}

output clusterName string = cluster.name
output hostName string = cluster.properties.hostName
output port int = database.properties.port
