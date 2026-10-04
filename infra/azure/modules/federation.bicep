// Federated credentials: each Kubernetes service account (AKS OIDC issuer) and each GitHub
// environment (GitHub OIDC issuer) can exchange its own token for exactly one managed identity.
@description('{ identityName, serviceAccount } per workload identity.')
param kubernetesCredentials array
param kubernetesNamespace string
param aksOidcIssuerUrl string
@description('{ identityName, environment } per GitHub environment identity.')
param githubCredentials array
param githubRepository string
param audience string = 'api://AzureADTokenExchange'

var kubernetesFederation = [for item in kubernetesCredentials: {
  identityName: item.identityName
  name: 'aks-${item.serviceAccount}'
  issuer: aksOidcIssuerUrl
  subject: 'system:serviceaccount:${kubernetesNamespace}:${item.serviceAccount}'
}]
var githubFederation = [for item in githubCredentials: {
  identityName: item.identityName
  name: 'github-${item.environment}'
  issuer: 'https://token.actions.githubusercontent.com'
  subject: 'repo:${githubRepository}:environment:${item.environment}'
}]
var credentials = concat(kubernetesFederation, githubFederation)

resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = [for item in credentials: {
  name: item.identityName
}]

// Concurrent federated-credential writes on one identity are rejected, so create them serially.
@batchSize(1)
resource federated 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = [for (item, i) in credentials: {
  parent: identities[i]
  name: item.name
  properties: {
    issuer: item.issuer
    subject: item.subject
    audiences: [audience]
  }
}]
