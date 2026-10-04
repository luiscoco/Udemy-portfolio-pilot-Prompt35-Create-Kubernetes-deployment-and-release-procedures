// AKS with Entra-only access (Azure RBAC, local accounts disabled), OIDC issuer + workload identity,
// Azure CNI Overlay powered by Cilium (NetworkPolicy in milestone 35), egress via the NAT gateway,
// the Key Vault CSI driver with rotation, and Container insights over managed identity.
param location string
param tags object
param baseName string
param vnetName string
param aksSubnetName string
param natPublicIp string
@description('Empty uses the region default version (az aks get-versions shows the choices).')
param kubernetesVersion string
@allowed(['Free', 'Standard'])
param tier string
param nodeVmSize string
@minValue(1)
param nodeMinCount int
@minValue(1)
param nodeMaxCount int
param availabilityZones array
param podCidr string
param serviceCidr string
param dnsServiceIp string
@description('CIDRs allowed to reach the public API server. Empty leaves it open to the internet (Entra RBAC still applies).')
param authorizedIpRanges array
param logAnalyticsWorkspaceId string
param containerInsightsRuleId string
param acrName string

var roles = {
  networkContributor: '4d97b98b-1d4f-4787-a291-c67834d212e7'
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
}

resource vnet 'Microsoft.Network/virtualNetworks@2025-05-01' existing = { name: vnetName }
resource aksSubnet 'Microsoft.Network/virtualNetworks/subnets@2025-05-01' existing = {
  parent: vnet
  name: aksSubnetName
}
resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = { name: acrName }

// A user-assigned control-plane identity lets the subnet permission exist before the cluster does.
resource controlPlane 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-${baseName}-aks-control-plane'
  location: location
  tags: tags
}

resource subnetJoin 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aksSubnet.id, controlPlane.id, roles.networkContributor)
  scope: aksSubnet
  properties: {
    principalId: controlPlane.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.networkContributor)
  }
}

resource cluster 'Microsoft.ContainerService/managedClusters@2025-10-01' = {
  name: 'aks-${baseName}'
  location: location
  tags: tags
  sku: { name: 'Base', tier: tier }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${controlPlane.id}': {} }
  }
  properties: {
    kubernetesVersion: empty(kubernetesVersion) ? null : kubernetesVersion
    dnsPrefix: 'aks-${baseName}'
    nodeResourceGroup: 'rg-${baseName}-aks-nodes'
    enableRBAC: true
    disableLocalAccounts: true
    aadProfile: {
      managed: true
      enableAzureRBAC: true
      tenantID: tenant().tenantId
    }
    oidcIssuerProfile: { enabled: true }
    securityProfile: {
      workloadIdentity: { enabled: true }
    }
    // Nodes reach the public API server from the NAT IP, so it must be allowed when ranges are set.
    apiServerAccessProfile: empty(authorizedIpRanges) ? null : {
      authorizedIPRanges: union(authorizedIpRanges, ['${natPublicIp}/32'])
    }
    autoUpgradeProfile: {
      upgradeChannel: 'patch'
      nodeOSUpgradeChannel: 'NodeImage'
    }
    networkProfile: {
      networkPlugin: 'azure'
      networkPluginMode: 'overlay'
      networkDataplane: 'cilium'
      networkPolicy: 'cilium'
      podCidr: podCidr
      serviceCidr: serviceCidr
      dnsServiceIP: dnsServiceIp
      outboundType: 'userAssignedNATGateway'
      loadBalancerSku: 'standard'
    }
    agentPoolProfiles: [
      {
        name: 'system'
        mode: 'System'
        type: 'VirtualMachineScaleSets'
        vmSize: nodeVmSize
        count: nodeMinCount
        enableAutoScaling: true
        minCount: nodeMinCount
        maxCount: nodeMaxCount
        osType: 'Linux'
        osSKU: 'AzureLinux'
        osDiskType: 'Managed'
        osDiskSizeGB: 64
        vnetSubnetID: aksSubnet.id
        availabilityZones: empty(availabilityZones) ? null : availabilityZones
        upgradeSettings: { maxSurge: '1' }
      }
    ]
    addonProfiles: {
      azureKeyvaultSecretsProvider: {
        enabled: true
        config: {
          enableSecretRotation: 'true'
          rotationPollInterval: '2m'
        }
      }
      omsagent: {
        enabled: true
        config: {
          logAnalyticsWorkspaceResourceID: logAnalyticsWorkspaceId
          useAADAuth: 'true'
        }
      }
    }
  }
  dependsOn: [subnetJoin]
}

resource containerInsights 'Microsoft.Insights/dataCollectionRuleAssociations@2024-03-11' = {
  name: 'ContainerInsightsExtension'
  scope: cluster
  properties: {
    dataCollectionRuleId: containerInsightsRuleId
  }
}

resource kubeletPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, cluster.id, roles.acrPull)
  scope: registry
  properties: {
    principalId: cluster.properties.identityProfile.kubeletidentity.objectId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
  }
}

// The newest diagnostic-settings API with category groups is this preview; the GA 2016-09-01 lacks them.
#disable-next-line use-recent-api-versions
resource auditLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'audit-to-log-analytics'
  scope: cluster
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    // kube-audit-admin omits read-only requests; guard records Entra/RBAC decisions.
    logs: [
      { category: 'kube-audit-admin', enabled: true }
      { category: 'guard', enabled: true }
    ]
  }
}

output clusterId string = cluster.id
output clusterName string = cluster.name
output oidcIssuerUrl string = cluster.properties.oidcIssuerProfile.issuerURL
output nodeResourceGroup string = cluster.properties.nodeResourceGroup
