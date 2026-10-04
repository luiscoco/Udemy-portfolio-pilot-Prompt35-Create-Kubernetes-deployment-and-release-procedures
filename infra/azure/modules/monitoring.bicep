// Log Analytics (AKS Container insights, control-plane and data-service audit logs) and a
// workspace-based Application Insights resource for the OpenTelemetry collector (milestone 32/35).
param location string
param tags object
param baseName string
@minValue(30)
@maxValue(730)
param retentionDays int
@description('Daily ingestion cap in GB; -1 disables the cap. Ingestion stops for the day when reached.')
param dailyCapGb int

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-07-01' = {
  name: 'log-${baseName}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: retentionDays
    workspaceCapping: { dailyQuotaGb: dailyCapGb }
    features: {
      // Readers need table or workspace RBAC, not just resource access.
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${baseName}'
  location: location
  tags: tags
  kind: 'other'
  properties: {
    Application_Type: 'other'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    RetentionInDays: retentionDays
    // Local (connection-string key) ingestion stays enabled until the collector's Entra path is verified (docs/azure/credentials.md).
    DisableLocalAuth: false
  }
}

// Container insights with managed-identity ingestion requires an explicit data collection rule.
resource containerInsightsRule 'Microsoft.Insights/dataCollectionRules@2024-03-11' = {
  name: 'dcr-ci-${baseName}'
  location: location
  tags: tags
  kind: 'Linux'
  properties: {
    dataSources: {
      extensions: [
        {
          name: 'ContainerInsightsExtension'
          extensionName: 'ContainerInsights'
          streams: ['Microsoft-ContainerInsights-Group-Default']
          extensionSettings: {
            dataCollectionSettings: {
              interval: '1m'
              namespaceFilteringMode: 'Off'
              enableContainerLogV2: true
            }
          }
        }
      ]
    }
    destinations: {
      logAnalytics: [{ name: 'workspace', workspaceResourceId: workspace.id }]
    }
    dataFlows: [{ streams: ['Microsoft-ContainerInsights-Group-Default'], destinations: ['workspace'] }]
  }
}

output workspaceId string = workspace.id
output appInsightsId string = appInsights.id
output appInsightsName string = appInsights.name
output containerInsightsRuleId string = containerInsightsRule.id
