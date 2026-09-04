targetScope = 'subscription'

@description('Dedicated Workforce OS production resource group.')
param productionResourceGroupName string = 'workforce-os-prod'

@description('Azure region for the isolated production control plane.')
param location string = 'eastus'

param registryName string = 'workforceosprodacr'
param controlStorageAccountName string = 'workforceosprodctrl'
param controlContainerName string = 'production-control'
param controlBlobName string = 'workforce-os/initial-production-bootstrap/state-v1.json'
param authorityDrainCheckpointBlobName string = 'workforce-os/initial-production-bootstrap/authority-drain-checkpoint-v1'
param logAnalyticsWorkspaceName string = 'workforce-os-prod-logs'
param containerAppsEnvironmentName string = 'workforce-os-prod-env'
param publicConsoleHostname string = 'workforceos.xyz'
param publicApiHostname string = 'api.workforceos.xyz'
param publicConsoleCertificateName string = 'workforceos-root-v1'
param publicApiCertificateName string = 'workforceos-api-v1'
@description('Create immutable managed certificates on the initial apply. Set false for later stack updates.')
param createManagedCertificates bool = true
param identityNamePrefix string = 'workforce-os-v2'
param githubOwner string = 'Kloudedge-apex'
param backendRepository string = 'apex-product'
param consoleRepository string = 'Workforce-OS'
param buildEnvironmentName string = 'workforce-os-production-build'
param releaseEnvironmentName string = 'workforce-os-production'

resource productionResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: productionResourceGroupName
  location: location
  tags: {
    application: 'workforce-os'
    environment: 'production'
    managedBy: 'bicep-deployment-stack'
  }
}

resource acrBuildRunnerRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'workforce-os-isolated-acr-build-runner-v2')
  properties: {
    roleName: 'Workforce OS Isolated ACR Build Runner v2'
    description: 'May submit and read ACR quick builds; artifact pull is granted separately.'
    type: 'CustomRole'
    assignableScopes: [subscription().id]
    permissions: [
      {
        actions: [
          'Microsoft.ContainerRegistry/registries/read'
          'Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action'
          'Microsoft.ContainerRegistry/registries/scheduleRun/action'
          'Microsoft.ContainerRegistry/registries/runs/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

resource containerAppReleaseRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'workforce-os-isolated-container-app-release-v2')
  properties: {
    roleName: 'Workforce OS Isolated Container App Release v2'
    description: 'May read and update assigned Workforce OS Container Apps and activate existing revisions.'
    type: 'CustomRole'
    assignableScopes: [subscription().id]
    permissions: [
      {
        actions: [
          'Microsoft.App/containerApps/read'
          'Microsoft.App/containerApps/write'
          'Microsoft.App/containerApps/listCustomHostNameAnalysis/action'
          'Microsoft.App/containerApps/listSecrets/action'
          'Microsoft.App/containerApps/revisions/read'
          'Microsoft.App/containerApps/revisions/activate/action'
          'Microsoft.Authorization/roleAssignments/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

resource controlBlobOperatorRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'workforce-os-isolated-control-blob-operator-v2')
  properties: {
    roleName: 'Workforce OS Isolated Control Blob Operator v2'
    description: 'May read and write only the exact condition-bound production state and drain-checkpoint blobs.'
    type: 'CustomRole'
    assignableScopes: [subscription().id]
    permissions: [
      {
        actions: [
          'Microsoft.Storage/storageAccounts/read'
          'Microsoft.Authorization/roleAssignments/read'
        ]
        notActions: []
        dataActions: [
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'
        ]
        notDataActions: []
      }
    ]
  }
}

resource authorityAuditReaderRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'workforce-os-isolated-authority-audit-reader-v2')
  properties: {
    roleName: 'Workforce OS Isolated Authority Audit Reader v2'
    description: 'May read the exact Azure configuration and deny boundary used by the Workforce OS authority audit.'
    type: 'CustomRole'
    assignableScopes: [subscription().id]
    permissions: [
      {
        actions: [
          'Microsoft.Resources/subscriptions/read'
          'Microsoft.Resources/subscriptions/resourceGroups/read'
          'Microsoft.Resources/deploymentStacks/read'
          'Microsoft.Authorization/roleAssignments/read'
          'Microsoft.Authorization/roleDefinitions/read'
          'Microsoft.Authorization/denyAssignments/read'
          'Microsoft.App/containerApps/read'
          'Microsoft.App/managedEnvironments/read'
          'Microsoft.App/managedEnvironments/managedCertificates/read'
          'Microsoft.ManagedIdentity/userAssignedIdentities/read'
          'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/read'
          'Microsoft.ContainerRegistry/registries/read'
          'Microsoft.ContainerRegistry/registries/tokens/read'
          'Microsoft.ContainerRegistry/registries/tasks/read'
          'Microsoft.Storage/storageAccounts/read'
          'Microsoft.Storage/storageAccounts/blobServices/read'
          'Microsoft.Storage/storageAccounts/blobServices/containers/read'
          'Microsoft.Storage/storageAccounts/localusers/read'
          'Microsoft.Storage/storageAccounts/managementPolicies/read'
          'Microsoft.Storage/storageAccounts/objectReplicationPolicies/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

module isolatedResources './resources.bicep' = {
  name: 'workforce-os-production-isolation-v2'
  scope: productionResourceGroup
  params: {
    location: location
    registryName: registryName
    controlStorageAccountName: controlStorageAccountName
    controlContainerName: controlContainerName
    controlBlobName: controlBlobName
    authorityDrainCheckpointBlobName: authorityDrainCheckpointBlobName
    logAnalyticsWorkspaceName: logAnalyticsWorkspaceName
    containerAppsEnvironmentName: containerAppsEnvironmentName
    publicConsoleHostname: publicConsoleHostname
    publicApiHostname: publicApiHostname
    publicConsoleCertificateName: publicConsoleCertificateName
    publicApiCertificateName: publicApiCertificateName
    createManagedCertificates: createManagedCertificates
    identityNamePrefix: identityNamePrefix
    githubOwner: githubOwner
    backendRepository: backendRepository
    consoleRepository: consoleRepository
    buildEnvironmentName: buildEnvironmentName
    releaseEnvironmentName: releaseEnvironmentName
    acrBuildRunnerRoleDefinitionId: acrBuildRunnerRole.id
    controlBlobOperatorRoleDefinitionId: controlBlobOperatorRole.id
    acrPullRoleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}

resource backendAuthorityAuditRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, 'workforce-os-v2-backend-release', authorityAuditReaderRole.id)
  properties: {
    principalId: isolatedResources.outputs.authority.backendRelease.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: authorityAuditReaderRole.id
  }
}

resource consoleAuthorityAuditRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, 'workforce-os-v2-console-release', authorityAuditReaderRole.id)
  properties: {
    principalId: isolatedResources.outputs.authority.consoleRelease.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: authorityAuditReaderRole.id
  }
}

output isolation object = {
  subscriptionId: subscription().subscriptionId
  resourceGroup: productionResourceGroup.name
  registry: isolatedResources.outputs.registry
  controlStorage: isolatedResources.outputs.controlStorage
  containerAppsEnvironment: isolatedResources.outputs.containerAppsEnvironment
  managedCertificates: isolatedResources.outputs.managedCertificates
  runtimeImagePull: isolatedResources.outputs.runtimeImagePull
  authority: isolatedResources.outputs.authority
  roleDefinitions: {
    acrBuildRunner: acrBuildRunnerRole.id
    containerAppRelease: containerAppReleaseRole.id
    controlBlobOperator: controlBlobOperatorRole.id
    authorityAuditReader: authorityAuditReaderRole.id
  }
}
