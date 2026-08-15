targetScope = 'managementGroup'

param backendReleasePrincipalId string
param consoleReleasePrincipalId string

var authorityAuditManagementGroupScope = '/providers/Microsoft.Management/managementGroups/d4b3813d-146f-4d03-96b8-d6e5862d58a2'

resource authorityAuditManagementGroupReaderRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(authorityAuditManagementGroupScope, 'workforce-os-authority-audit-management-group-reader-v1')
  properties: {
    roleName: 'Workforce OS Authority Audit Management Group Reader v1'
    description: 'May read authorization, PIM, Resource Graph, and management-group ancestry required by the fail-closed production-authority audit; grants no mutation or data-plane authority.'
    type: 'CustomRole'
    assignableScopes: [authorityAuditManagementGroupScope]
    permissions: [
      {
        actions: [
          'Microsoft.Authorization/roleAssignments/read'
          'Microsoft.Authorization/roleDefinitions/read'
          'Microsoft.Authorization/roleAssignmentScheduleInstances/read'
          'Microsoft.Authorization/roleEligibilityScheduleInstances/read'
          'Microsoft.ResourceGraph/resources/read'
          'Microsoft.Management/managementGroups/read'
          'Microsoft.Management/managementGroups/subscriptions/read'
          'Microsoft.Resources/subscriptions/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

resource backendAuthorityAuditManagementGroupRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(managementGroup().id, backendReleasePrincipalId, authorityAuditManagementGroupReaderRole.id)
  properties: {
    principalId: backendReleasePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: authorityAuditManagementGroupReaderRole.id
  }
}

resource consoleAuthorityAuditManagementGroupRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(managementGroup().id, consoleReleasePrincipalId, authorityAuditManagementGroupReaderRole.id)
  properties: {
    principalId: consoleReleasePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: authorityAuditManagementGroupReaderRole.id
  }
}

output roleDefinitionId string = authorityAuditManagementGroupReaderRole.id
