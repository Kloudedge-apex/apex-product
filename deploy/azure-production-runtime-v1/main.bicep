targetScope = 'resourceGroup'

@description('Legacy resource group that currently holds the approved source secret set.')
param sourceResourceGroupName string = 'Ledgr-prod'

param sourceApiName string = 'apex-gtm-api'
param targetContainerAppsEnvironmentName string = 'workforce-os-prod-env'
param registryLoginServer string = 'workforceosprodacr.azurecr.io'
param runtimePullIdentityName string = 'workforce-os-v2-runtime-pull'
param backendReleaseIdentityName string = 'workforce-os-v2-backend-release'
param consoleReleaseIdentityName string = 'workforce-os-v2-console-release'

@description('Immutable legacy runtime copied into the isolated registry for the bootstrap source baseline.')
param backendSourceImage string = 'workforceosprodacr.azurecr.io/apex-api@sha256:111a470e65a22d27039d0d130d7d0c7aa33e7a23e0d8ce8fe7183c685dbf6f25'

@description('Immutable console candidate already built in the isolated registry.')
param consoleSourceImage string = 'workforceosprodacr.azurecr.io/workforceos-fe@sha256:c83bd7b774fa9ed7f83ffd2ad621c1c0edc2502e495d3feab43916e5378dd6ff'

param publicApiOrigin string = 'https://api.workforceos.xyz'
param publicConsoleOrigin string = 'https://workforceos.xyz'
param clerkIssuer string = 'https://clerk.workforceos.xyz'
param clerkJwksUrl string = 'https://clerk.workforceos.xyz/.well-known/jwks.json'

var apiName = 'apex-gtm-api'
var workerName = 'apex-gtm-worker'
var consoleName = 'nikxius-web'
var oldRegistryPasswordSecretName = 'ledgracrazurecrio-ledgracr'
var metricsSecretName = 'metrics-auth-token'
var containerAppReleaseRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  guid(subscription().id, 'workforce-os-isolated-container-app-release-v2')
)

resource sourceApi 'Microsoft.App/containerApps@2024-03-01' existing = {
  scope: resourceGroup(subscription().subscriptionId, sourceResourceGroupName)
  name: sourceApiName
}

resource targetEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: targetContainerAppsEnvironmentName
}

resource runtimePullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: runtimePullIdentityName
}

resource backendReleaseIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: backendReleaseIdentityName
}

resource consoleReleaseIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: consoleReleaseIdentityName
}

var sourceApiSecrets = filter(
  sourceApi.listSecrets().value,
  secret => secret.name != oldRegistryPasswordSecretName && secret.name != metricsSecretName
)
var sourceMetricsValue = first(filter(
  sourceApi.properties.template.containers[0].env,
  item => item.name == 'METRICS_AUTH_TOKEN'
))!.value
var copiedSecrets = map(sourceApiSecrets, secret => {
    name: secret.name
    value: secret.value
})
var runtimeSecrets = concat(copiedSecrets, [
  {
    name: metricsSecretName
    value: sourceMetricsValue
  }
])

var sharedPlainEnvironment = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'REQUIRE_PRODUCTION_ENV', value: 'true' }
  { name: 'API_PORT', value: '4000' }
  { name: 'SCHEDULER_ENABLED', value: 'false' }
  { name: 'CORS_ALLOWED_ORIGINS', value: publicConsoleOrigin }
  { name: 'API_PUBLIC_URL', value: publicApiOrigin }
  { name: 'APEX_PUBLIC_BASE_URL', value: publicApiOrigin }
  { name: 'FRONTEND_URL', value: publicConsoleOrigin }
  { name: 'CLERK_JWKS_URL', value: clerkJwksUrl }
  { name: 'CLERK_ISSUER', value: clerkIssuer }
  { name: 'CLERK_DOMAIN', value: '' }
  { name: 'CLERK_AUDIENCE', value: '' }
  { name: 'CLERK_AUTHORIZED_PARTIES', value: publicConsoleOrigin }
  { name: 'CLERK_PUBLISHABLE_KEY', value: 'pk_live_Y2xlcmsud29ya2ZvcmNlb3MueHl6JA' }
  { name: 'MICROSOFT_CLIENT_ID', value: '7f032ad8-2a63-4715-b43e-6e642e3be5dd' }
  { name: 'MICROSOFT_REDIRECT_URI', value: '${publicApiOrigin}/api/integrations/outlook/callback' }
  { name: 'GOOGLE_CLIENT_ID', value: '811409477895-07r33nncoq3b90e38os5eh4feqbt4k8p.apps.googleusercontent.com' }
  { name: 'GOOGLE_REDIRECT_URI', value: '${publicApiOrigin}/api/integrations/gmail/callback' }
  { name: 'GMAIL_PUSH_AUDIENCE', value: '${publicApiOrigin}/api/integrations/gmail/push' }
  { name: 'GMAIL_PUSH_PUBLISHER_SA', value: 'gmail-push-publisher@supple-design-494220-v3.iam.gserviceaccount.com' }
  { name: 'GMAIL_PUBSUB_TOPIC', value: 'projects/supple-design-494220-v3/topics/gmail-inbound' }
  { name: 'AZURE_OPENAI_ENDPOINT', value: 'https://apex-openai-1e0f1.openai.azure.com/' }
  { name: 'AZURE_OPENAI_DEPLOYMENT', value: 'gpt-4-1-mini' }
  { name: 'AZURE_OPENAI_REASONING_ENDPOINT', value: 'https://nikhil-apex-openclaw-resource.cognitiveservices.azure.com/' }
  { name: 'AZURE_OPENAI_REASONING_DEPLOYMENT', value: 'gpt-5' }
  { name: 'AZURE_OPENAI_FAST_DEPLOYMENT', value: 'gpt-5.4-mini' }
  { name: 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT', value: 'text-embedding-3-large' }
  { name: 'AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT', value: 'gpt-4o-mini-transcribe' }
  { name: 'LANGSMITH_TRACING', value: 'true' }
  { name: 'LANGSMITH_PROJECT', value: 'Project Workforce-OS' }
  { name: 'LANGSMITH_CAPTURE_PROMPTS', value: 'true' }
  { name: 'OUTREACH_LIVE_FOR_ORGS', value: 'cmpe63k370000ap01vsiehbj2' }
  { name: 'OUTREACH_ALLOW_WILDCARD', value: 'false' }
  { name: 'OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE', value: 'disabled' }
  { name: 'APEX_TENANT_ZERO_ORG_ID', value: 'cmpe63k370000ap01vsiehbj2' }
]

var sharedSecretEnvironment = [
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'REDIS_URL', secretRef: 'redis-url' }
  { name: 'CLERK_SECRET_KEY', secretRef: 'clerk-secret-key' }
  { name: 'ENCRYPTION_KEY', secretRef: 'encryption-key' }
  { name: 'ADMIN_API_KEY', secretRef: 'admin-api-key' }
  { name: 'GOOGLE_CLIENT_SECRET', secretRef: 'google-client-secret' }
  { name: 'MICROSOFT_CLIENT_SECRET', secretRef: 'microsoft-client-secret' }
  { name: 'HUBSPOT_CLIENT_SECRET', secretRef: 'hubspot-client-secret' }
  { name: 'HUBSPOT_ACCESS_TOKEN', secretRef: 'hubspot-access-token' }
  { name: 'HUBSPOT_APP_SECRET', secretRef: 'hubspot-app-secret' }
  { name: 'APOLLO_API_KEY', secretRef: 'apollo-api-key' }
  { name: 'INSTANTLY_API_KEY', secretRef: 'instantly-api-key' }
  { name: 'SERPER_API_KEY', secretRef: 'serper-api-key' }
  { name: 'LANGSMITH_API_KEY', secretRef: 'langsmith-api-key' }
  { name: 'OAUTH_STATE_SECRET', secretRef: 'oauth-state-secret' }
  { name: 'AZURE_OPENAI_KEY', secretRef: 'azure-openai-key' }
  { name: 'AZURE_OPENAI_REASONING_KEY', secretRef: 'azure-openai-reasoning-key' }
  { name: 'OUTREACH_UNSUBSCRIBE_SECRET', secretRef: 'outreach-unsubscribe-secret' }
  { name: 'METRICS_AUTH_TOKEN', secretRef: metricsSecretName }
]

var apiEnvironment = concat(sharedPlainEnvironment, sharedSecretEnvironment, [
  { name: 'WORKER_ENABLED', value: 'false' }
  { name: 'GRAPH_RUN_WORKER_ENABLED', value: 'false' }
  { name: 'OUTREACH_WORKER_ENABLED', value: 'false' }
  { name: 'USAGE_ROLLUP_WORKER_ENABLED', value: 'false' }
  { name: 'CLERK_WEBHOOK_SECRET', secretRef: 'clerk-webhook-secret' }
])

var workerEnvironment = concat(sharedPlainEnvironment, sharedSecretEnvironment, [
  { name: 'WORKER_ENABLED', value: 'true' }
  { name: 'GRAPH_RUN_WORKER_ENABLED', value: 'true' }
  { name: 'OUTREACH_WORKER_ENABLED', value: 'true' }
  { name: 'USAGE_ROLLUP_WORKER_ENABLED', value: 'true' }
])

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: apiName
  location: resourceGroup().location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimePullIdentity.id}': {}
    }
  }
  properties: {
    environmentId: targetEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 10
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 4000
        transport: 'auto'
      }
      registries: [
        {
          server: registryLoginServer
          identity: runtimePullIdentity.id
        }
      ]
      secrets: runtimeSecrets
    }
    template: {
      revisionSuffix: 'bootstrap-source-324f831'
      containers: [
        {
          name: apiName
          image: backendSourceImage
          env: apiEnvironment
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/api/health/live', port: 4000, scheme: 'HTTP' }
              initialDelaySeconds: 30
              periodSeconds: 15
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/health/ready', port: 4000, scheme: 'HTTP' }
              initialDelaySeconds: 10
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Startup'
              httpGet: { path: '/api/health/live', port: 4000, scheme: 'HTTP' }
              initialDelaySeconds: 5
              periodSeconds: 5
              timeoutSeconds: 5
              failureThreshold: 24
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
  tags: {
    application: 'workforce-os'
    environment: 'production'
    lifecycle: 'bootstrap-source'
  }
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: workerName
  location: resourceGroup().location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimePullIdentity.id}': {}
    }
  }
  properties: {
    environmentId: targetEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 10
      registries: [
        {
          server: registryLoginServer
          identity: runtimePullIdentity.id
        }
      ]
      secrets: runtimeSecrets
    }
    template: {
      revisionSuffix: 'bootstrap-source-324f831'
      containers: [
        {
          name: workerName
          image: backendSourceImage
          env: workerEnvironment
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/api/health/live', port: 4000, scheme: 'HTTP' }
              initialDelaySeconds: 30
              periodSeconds: 15
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/health/worker', port: 4000, scheme: 'HTTP' }
              initialDelaySeconds: 10
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Startup'
              httpGet: { path: '/api/health/live', port: 4000, scheme: 'HTTP' }
              initialDelaySeconds: 5
              periodSeconds: 5
              timeoutSeconds: 5
              failureThreshold: 24
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
  tags: {
    application: 'workforce-os'
    environment: 'production'
    lifecycle: 'bootstrap-source'
  }
}

resource console 'Microsoft.App/containerApps@2024-03-01' = {
  name: consoleName
  location: resourceGroup().location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimePullIdentity.id}': {}
    }
  }
  properties: {
    environmentId: targetEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 10
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: registryLoginServer
          identity: runtimePullIdentity.id
        }
      ]
    }
    template: {
      revisionSuffix: 'bootstrap-source-50f3a1c'
      containers: [
        {
          name: consoleName
          image: consoleSourceImage
          env: [
            { name: 'API_UPSTREAM_URL', value: 'https://${api.properties.configuration.ingress.fqdn}' }
            { name: 'CLERK_AUTHORIZED_PARTIES', value: publicConsoleOrigin }
            { name: 'CLERK_ISSUER', value: clerkIssuer }
            { name: 'CLERK_JWKS_URL', value: clerkJwksUrl }
            { name: 'DEV_TRUST_X_ORG_ID', value: 'false' }
            { name: 'FE_DIST', value: '/app/artifacts/workforce-os/dist/public' }
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8080' }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/api/healthz', port: 8080, scheme: 'HTTP' }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
              successThreshold: 1
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
      }
    }
  }
  tags: {
    application: 'workforce-os'
    environment: 'production'
    lifecycle: 'bootstrap-source'
  }
}

resource apiBackendRelease 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(api.id, backendReleaseIdentity.id, containerAppReleaseRoleDefinitionId)
  scope: api
  properties: {
    principalId: backendReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: containerAppReleaseRoleDefinitionId
  }
}

resource workerBackendRelease 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(worker.id, backendReleaseIdentity.id, containerAppReleaseRoleDefinitionId)
  scope: worker
  properties: {
    principalId: backendReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: containerAppReleaseRoleDefinitionId
  }
}

resource consoleBackendRelease 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(console.id, backendReleaseIdentity.id, containerAppReleaseRoleDefinitionId)
  scope: console
  properties: {
    principalId: backendReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: containerAppReleaseRoleDefinitionId
  }
}

resource consoleConsoleRelease 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(console.id, consoleReleaseIdentity.id, containerAppReleaseRoleDefinitionId)
  scope: console
  properties: {
    principalId: consoleReleaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: containerAppReleaseRoleDefinitionId
  }
}

output runtime object = {
  api: {
    resourceId: api.id
    fqdn: api.properties.configuration.ingress.fqdn
  }
  worker: {
    resourceId: worker.id
  }
  console: {
    resourceId: console.id
    fqdn: console.properties.configuration.ingress.fqdn
  }
}
