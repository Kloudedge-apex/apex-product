targetScope = 'subscription'

@description('Existing Workforce OS production resource group.')
param productionResourceGroupName string = 'Ledgr-prod'

@description('Location for the four user-assigned OIDC identities.')
param location string = 'eastus'

@description('Existing production Azure Container Registry.')
param registryName string = 'ledgracr'

@description('Existing storage account that will contain the fixed control blob.')
param controlStorageAccountName string = 'ledgrstorage'

param controlContainerName string = 'production-control'
param controlBlobName string = 'workforce-os/initial-production-bootstrap/state-v1.json'
param identityNamePrefix string = 'workforce-os'
param githubOwner string = 'Kloudedge-apex'
param backendRepository string = 'apex-product'
param consoleRepository string = 'Workforce-OS'
param buildEnvironmentName string = 'workforce-os-production-build'
param releaseEnvironmentName string = 'workforce-os-production'

resource productionResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' existing = {
  name: productionResourceGroupName
}

resource acrBuildRunnerRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'workforce-os-acr-build-runner-v1')
  properties: {
    roleName: 'Workforce OS ACR Build Runner v1'
    description: 'May submit and read ACR quick builds; artifact pull and tag reads are granted separately through AcrPull.'
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
  name: guid(subscription().id, 'workforce-os-container-app-release-v1')
  properties: {
    roleName: 'Workforce OS Container App Release v1'
    description: 'May read and update an assigned Container App and activate existing revisions; cannot delete apps, read secrets, execute commands, or manage the environment.'
    type: 'CustomRole'
    assignableScopes: [subscription().id]
    permissions: [
      {
        actions: [
          'Microsoft.App/containerApps/read'
          'Microsoft.App/containerApps/write'
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
  name: guid(subscription().id, 'workforce-os-control-blob-operator-v1')
  properties: {
    roleName: 'Workforce OS Control Blob Operator v1'
    description: 'May read and write only the condition-bound production control blob; deletion is excluded.'
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

module authorityResources './resources.bicep' = {
  name: 'workforce-os-production-authority-v1'
  scope: productionResourceGroup
  params: {
    location: location
    registryName: registryName
    controlStorageAccountName: controlStorageAccountName
    controlContainerName: controlContainerName
    controlBlobName: controlBlobName
    identityNamePrefix: identityNamePrefix
    githubOwner: githubOwner
    backendRepository: backendRepository
    consoleRepository: consoleRepository
    buildEnvironmentName: buildEnvironmentName
    releaseEnvironmentName: releaseEnvironmentName
    acrBuildRunnerRoleDefinitionId: acrBuildRunnerRole.id
    containerAppReleaseRoleDefinitionId: containerAppReleaseRole.id
    controlBlobOperatorRoleDefinitionId: controlBlobOperatorRole.id
    acrPullRoleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}

output authority object = authorityResources.outputs.authority
