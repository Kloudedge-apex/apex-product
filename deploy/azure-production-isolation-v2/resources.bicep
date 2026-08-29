targetScope = 'resourceGroup'

param location string
param registryName string
param controlStorageAccountName string
param controlContainerName string
param controlBlobName string
param authorityDrainCheckpointBlobName string
param logAnalyticsWorkspaceName string
param containerAppsEnvironmentName string
param publicConsoleHostname string
param publicApiHostname string
param publicConsoleCertificateName string
param publicApiCertificateName string
param identityNamePrefix string
param githubOwner string
param backendRepository string
param consoleRepository string
param buildEnvironmentName string
param releaseEnvironmentName string
param acrBuildRunnerRoleDefinitionId string
param controlBlobOperatorRoleDefinitionId string
param acrPullRoleDefinitionId string

var issuer = 'https://token.actions.githubusercontent.com'
var audience = 'api://AzureADTokenExchange'
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

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    dataEndpointEnabled: false
    publicNetworkAccess: 'Enabled'
    networkRuleBypassOptions: 'AzureServices'
  }
  tags: {
    application: 'workforce-os'
    environment: 'production'
  }
}

resource controlStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: controlStorageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    isHnsEnabled: false
    isLocalUserEnabled: false
    isSftpEnabled: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
  tags: {
    application: 'workforce-os'
    environment: 'production'
  }
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

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  properties: {
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
  tags: {
    application: 'workforce-os'
    environment: 'production'
  }
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppsEnvironmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
  }
  tags: {
    application: 'workforce-os'
    environment: 'production'
  }
}

resource publicConsoleCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' = {
  parent: containerAppsEnvironment
  name: publicConsoleCertificateName
  location: location
  properties: {
    subjectName: publicConsoleHostname
    domainControlValidation: 'TXT'
  }
}

resource publicApiCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' = {
  parent: containerAppsEnvironment
  name: publicApiCertificateName
  location: location
  properties: {
    subjectName: publicApiHostname
    domainControlValidation: 'TXT'
  }
}

resource backendBuildIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: format('{0}-backend-build', identityNamePrefix)
  location: location
  tags: {
    application: 'workforce-os'
    authority: 'candidate-build'
  }
}

resource consoleBuildIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: format('{0}-console-build', identityNamePrefix)
  location: location
  tags: {
    application: 'workforce-os'
    authority: 'candidate-build'
  }
}

resource backendReleaseIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: format('{0}-backend-release', identityNamePrefix)
  location: location
  tags: {
    application: 'workforce-os'
    authority: 'production-release'
  }
}

resource consoleReleaseIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: format('{0}-console-release', identityNamePrefix)
  location: location
  tags: {
    application: 'workforce-os'
    authority: 'production-release'
  }
}

resource runtimeImagePullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: format('{0}-runtime-pull', identityNamePrefix)
  location: location
  tags: {
    application: 'workforce-os'
    authority: 'runtime-image-pull'
  }
}

resource backendBuildFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: backendBuildIdentity
  name: 'github-environment'
  properties: {
    issuer: issuer
    audiences: [audience]
    subject: format('repo:{0}/{1}:environment:{2}', githubOwner, backendRepository, buildEnvironmentName)
  }
}

resource consoleBuildFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: consoleBuildIdentity
  name: 'github-environment'
  properties: {
    issuer: issuer
    audiences: [audience]
    subject: format('repo:{0}/{1}:environment:{2}', githubOwner, consoleRepository, buildEnvironmentName)
  }
}

resource backendReleaseFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: backendReleaseIdentity
  name: 'github-environment'
  properties: {
    issuer: issuer
    audiences: [audience]
    subject: format('repo:{0}/{1}:environment:{2}', githubOwner, backendRepository, releaseEnvironmentName)
  }
}

resource consoleReleaseFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: consoleReleaseIdentity
  name: 'github-environment'
  properties: {
    issuer: issuer
    audiences: [audience]
    subject: format('repo:{0}/{1}:environment:{2}', githubOwner, consoleRepository, releaseEnvironmentName)
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

resource runtimeImagePullAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, runtimeImagePullIdentity.name, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: runtimeImagePullIdentity.properties.principalId
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

output registry object = {
  name: registry.name
  loginServer: registry.properties.loginServer
  resourceId: registry.id
}

output controlStorage object = {
  name: controlStorage.name
  resourceId: controlStorage.id
  container: controlContainer.name
  stateBlob: controlBlobName
  authorityDrainCheckpointBlob: authorityDrainCheckpointBlobName
}

output containerAppsEnvironment object = {
  name: containerAppsEnvironment.name
  resourceId: containerAppsEnvironment.id
}

output managedCertificates object = {
  publicConsole: {
    name: publicConsoleCertificate.name
    hostname: publicConsoleHostname
    resourceId: publicConsoleCertificate.id
  }
  publicApi: {
    name: publicApiCertificate.name
    hostname: publicApiHostname
    resourceId: publicApiCertificate.id
  }
}

output runtimeImagePull object = {
  clientId: runtimeImagePullIdentity.properties.clientId
  principalId: runtimeImagePullIdentity.properties.principalId
  resourceId: runtimeImagePullIdentity.id
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
}
