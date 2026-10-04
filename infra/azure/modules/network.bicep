// Network design (docs/azure/network.md): one VNet, an AKS node subnet whose egress leaves through a
// NAT gateway with a static IP, and a private-endpoint subnet that only the node subnet may reach.
// PostgreSQL, Redis, Key Vault and Blob resolve to private IPs through linked private DNS zones.
param location string
param tags object
param baseName string
param vnetAddressPrefix string
param aksSubnetPrefix string
param privateEndpointSubnetPrefix string
@minValue(4)
@maxValue(120)
param natIdleTimeoutMinutes int

// Recommended zone names (learn.microsoft.com/azure/private-link/private-endpoint-dns), commercial cloud.
// Order matters: outputs index into this array.
var privateDnsZoneNames = [
  'privatelink.postgres.database.azure.com'
  'privatelink.redis.azure.net'
  'privatelink.vaultcore.azure.net'
  'privatelink.blob.${environment().suffixes.storage}'
]

resource natIp 'Microsoft.Network/publicIPAddresses@2025-05-01' = {
  name: 'pip-ng-${baseName}'
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Regional' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource nat 'Microsoft.Network/natGateways@2025-05-01' = {
  name: 'ng-${baseName}'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    // Long model streams keep sending bytes; the timeout only reaps idle flows.
    idleTimeoutInMinutes: natIdleTimeoutMinutes
    publicIpAddresses: [{ id: natIp.id }]
  }
}

resource privateEndpointNsg 'Microsoft.Network/networkSecurityGroups@2025-05-01' = {
  name: 'nsg-pe-${baseName}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-aks-nodes-to-data-services'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          // Azure CNI Overlay SNATs pod traffic to the node IP for VNet destinations.
          sourceAddressPrefix: aksSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: privateEndpointSubnetPrefix
          destinationPortRanges: ['5432', '10000', '443']
        }
      }
      {
        name: 'deny-other-vnet-inbound'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2025-05-01' = {
  name: 'vnet-${baseName}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [vnetAddressPrefix] }
    subnets: [
      {
        name: 'snet-aks-nodes'
        properties: {
          addressPrefix: aksSubnetPrefix
          natGateway: { id: nat.id }
          defaultOutboundAccess: false
        }
      }
      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          networkSecurityGroup: { id: privateEndpointNsg.id }
          // Enforce the NSG above on private endpoint traffic.
          privateEndpointNetworkPolicies: 'Enabled'
          defaultOutboundAccess: false
        }
      }
    ]
  }
}

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for zone in privateDnsZoneNames: {
  name: zone
  location: 'global'
  tags: tags
}]

resource zoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (zone, i) in privateDnsZoneNames: {
  parent: zones[i]
  name: 'link-${baseName}'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    // Resolution of other services' public names (Anthropic, Alpaca, Entra) is unaffected: only these zones are private.
    resolutionPolicy: 'Default'
    virtualNetwork: { id: vnet.id }
  }
}]

output vnetId string = vnet.id
output aksSubnetId string = vnet.properties.subnets[0].id
output privateEndpointSubnetId string = vnet.properties.subnets[1].id
output natPublicIp string = natIp.properties.ipAddress
output privateDnsZoneIds object = {
  postgres: zones[0].id
  redis: zones[1].id
  keyVault: zones[2].id
  blob: zones[3].id
}
