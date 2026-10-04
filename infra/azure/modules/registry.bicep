// Container registry. Basic/Standard have a public endpoint (images are not data; pulls and pushes
// still require Entra roles). Private endpoints and firewall rules need Premium (docs/azure/network.md).
param location string
param tags object
param name string
@allowed(['Basic', 'Standard', 'Premium'])
param sku string

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: sku }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

output name string = registry.name
output loginServer string = registry.properties.loginServer
