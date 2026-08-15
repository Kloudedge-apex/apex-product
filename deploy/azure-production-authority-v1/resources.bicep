targetScope = 'resourceGroup'

param location string
param registryName string
param controlStorageAccountName string
param controlContainerName string
param controlBlobName string
param authorityDrainCheckpointBlobName string
param identityNamePrefix string
param githubOwner string
param backendRepository string
param consoleRepository string
param buildEnvironmentName string
param releaseEnvironmentName string
param acrBuildRunnerRoleDefinitionId string
param containerAppReleaseRoleDefinitionId string
param controlBlobOperatorRoleDefinitionId string
param acrPullRoleDefinitionId string

var issuer = 'https://token.actions.githubusercontent.com'
var audience = 'api://AzureADTokenExchange'
var apiAppName = 'apex-gtm-api'
var workerAppName = 'apex-gtm-worker'
var consoleAppName = 'nikxius-web'
var controlBlobCondition = format('''
(
  (
    !(ActionMatches{{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'}})
    AND
    !(ActionMatches{{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'}})
  )
  OR
  (
    @Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name]
      StringEquals '{0}'
    AND
    (
      @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path]
        StringEquals '{1}'
      OR
      @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path]
        StringEquals '{2}'
    )
  )
)
''', controlContainerName, controlBlobName, authorityDrainCheckpointBlobName)

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource controlStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: controlStorageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: controlStorage
  name: 'default'
}

resource controlContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: controlContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource apiApp 'Microsoft.App/containerApps@2025-01-01' existing = {
  name: apiAppName
}

resource workerApp 'Microsoft.App/containerApps@2025-01-01' existing = {
  name: workerAppName
}

resource consoleApp 'Microsoft.App/containerApps@2025-01-01' existing = {
  name: consoleAppName
}

resource backendBuildIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: format('{0}-backend-build', identityNamePrefix)
  location: location
}

resource consoleBuildIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: format('{0}-console-build', identityNamePrefix)
  location: location
}

resource backendReleaseIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: format('{0}-backend-release', identityNamePrefix)
  location: location
}

resource consoleReleaseIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: format('{0}-console-release', identityNamePrefix)
  location: location
}

resource backendBuildFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: backendBuildIdentity
  name: 'github-environment'
  properties: {
    issuer: issuer
    audiences: [audience]
    subject: format(
      'repo:{0}/{1}:environment:{2}',
      githubOwner,
      backendRepository,
      buildEnvironmentName
    )
  }
}

resource consoleBuildFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: consoleBuildIdentity
  name: 'github-environment'
  properties: {
    issuer: issuer
    audiences: [audience]
    subject: format(
      'repo:{0}/{1}:environment:{2}',
      githubOwner,
      consoleRepository,
      buildEnvironmentName
    )
  }
}

resource backendReleaseFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: backendReleaseIdentity
  name: 'github-environment'
  properties: {
    issuer: issuer
    audiences: [audience]
    subject: format(
      'repo:{0}/{1}:environment:{2}',
      githubOwner,
      backendRepository,
      releaseEnvironmentName
    )
  }
}

resource consoleReleaseFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: consoleReleaseIdentity
  name: 'github-environment'
  properties: {
    issuer: issuer
    audiences: [audience]
    subject: format(
      'repo:{0}/{1}:environment:{2}',
      githubOwner,
      consoleRepository,
      releaseEnvironmentName
    )
  }
}

resource backendBuildAcrBuild 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, backendBuildIdentity.name, acrBuildRunnerRoleDefinitionId)
  scope: registry
  properties: {
    principalId: backendBuildIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrBuildRunnerRoleDefinitionId
  }
}

resource consoleBuildAcrBuild 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, consoleBuildIdentity.name, acrBuildRunnerRoleDefinitionId)
  scope: registry
  properties: {
    principalId: consoleBuildIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrBuildRunnerRoleDefinitionId
  }
}

resource backendReleaseAcrBuild 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, backendReleaseIdentity.name, acrBuildRunnerRoleDefinitionId)
  scope: registry
  properties: {
    principalId: backendReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrBuildRunnerRoleDefinitionId
  }
}

resource consoleReleaseAcrBuild 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, consoleReleaseIdentity.name, acrBuildRunnerRoleDefinitionId)
  scope: registry
  properties: {
    principalId: consoleReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrBuildRunnerRoleDefinitionId
  }
}

resource backendBuildAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, backendBuildIdentity.name, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: backendBuildIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource consoleBuildAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, consoleBuildIdentity.name, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: consoleBuildIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource backendReleaseAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, backendReleaseIdentity.name, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: backendReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource consoleReleaseAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, consoleReleaseIdentity.name, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: consoleReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource backendControlBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(controlStorage.id, backendReleaseIdentity.name, controlBlobOperatorRoleDefinitionId, controlBlobName, authorityDrainCheckpointBlobName)
  scope: controlStorage
  properties: {
    principalId: backendReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: controlBlobOperatorRoleDefinitionId
    conditionVersion: '2.0'
    condition: controlBlobCondition
  }
}

resource consoleControlBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(controlStorage.id, consoleReleaseIdentity.name, controlBlobOperatorRoleDefinitionId, controlBlobName, authorityDrainCheckpointBlobName)
  scope: controlStorage
  properties: {
    principalId: consoleReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: controlBlobOperatorRoleDefinitionId
    conditionVersion: '2.0'
    condition: controlBlobCondition
  }
}

resource backendApiRelease 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(apiApp.id, backendReleaseIdentity.name, containerAppReleaseRoleDefinitionId)
  scope: apiApp
  properties: {
    principalId: backendReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: containerAppReleaseRoleDefinitionId
  }
}

resource backendWorkerRelease 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(workerApp.id, backendReleaseIdentity.name, containerAppReleaseRoleDefinitionId)
  scope: workerApp
  properties: {
    principalId: backendReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: containerAppReleaseRoleDefinitionId
  }
}

resource backendConsoleRelease 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(consoleApp.id, backendReleaseIdentity.name, containerAppReleaseRoleDefinitionId)
  scope: consoleApp
  properties: {
    principalId: backendReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: containerAppReleaseRoleDefinitionId
  }
}

resource consoleConsoleRelease 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(consoleApp.id, consoleReleaseIdentity.name, containerAppReleaseRoleDefinitionId)
  scope: consoleApp
  properties: {
    principalId: consoleReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: containerAppReleaseRoleDefinitionId
  }
}

output authority object = {
  backendBuild: {
    clientId: backendBuildIdentity.properties.clientId
    principalId: backendBuildIdentity.properties.principalId
    resourceId: backendBuildIdentity.id
  }
  consoleBuild: {
    clientId: consoleBuildIdentity.properties.clientId
    principalId: consoleBuildIdentity.properties.principalId
    resourceId: consoleBuildIdentity.id
  }
  backendRelease: {
    clientId: backendReleaseIdentity.properties.clientId
    principalId: backendReleaseIdentity.properties.principalId
    resourceId: backendReleaseIdentity.id
  }
  consoleRelease: {
    clientId: consoleReleaseIdentity.properties.clientId
    principalId: consoleReleaseIdentity.properties.principalId
    resourceId: consoleReleaseIdentity.id
  }
  registryResourceId: registry.id
  controlStorageResourceId: controlStorage.id
  controlContainerResourceId: controlContainer.id
  controlBlobName: controlBlobName
  authorityDrainCheckpointBlobName: authorityDrainCheckpointBlobName
  leaseBreakSeparableByRbac: false
}
