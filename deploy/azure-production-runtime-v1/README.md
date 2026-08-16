# Workforce OS isolated production runtime v1

This package creates the three Container Apps required by the reviewed
production bootstrap controller inside `workforce-os-prod`:

- `apex-gtm-api`;
- `apex-gtm-worker`;
- `nikxius-web`.

The API and worker begin on the immutable legacy runtime copied into
`workforceosprodacr`. That gives the bootstrap controller a known source
baseline before it creates the real writer-fence epoch and deploys the current
backend candidate. The console begins on the immutable candidate that includes
the guided-setup compatibility adapter. Its upstream remains the exact legacy
API origin pinned into that immutable image; cutover to the isolated API needs
a newly built console candidate with the new upstream pin.

## Secret boundary

ARM resolves the existing API Container App's secret set with `listSecrets()`
inside the deployment. Secret values are passed directly to the new Container
Apps and are never parameters, outputs, files, logs, or client-side command
arguments. The obsolete legacy ACR password secret is filtered out. The
existing metrics bearer value is converted from a plain environment variable
to a Container App secret reference; it still requires rotation during the
credential-drain window.

This package does not read secrets through Azure CLI and must never be changed
to output the `listSecrets()` result.

## Traffic boundary

The deployment creates external ingress endpoints so Azure can health-check
the API and console, but it does not change public DNS, custom-domain bindings,
or the live console's upstream. Production traffic remains on the existing
runtime until the signed bootstrap and promotion phases authorize cutover.

## Validate and deploy

```bash
az bicep build \
  --file deploy/azure-production-runtime-v1/main.bicep \
  --stdout >/dev/null

az deployment group validate \
  --subscription 3171575e-f164-425c-9ee0-2fb10cf93884 \
  --resource-group workforce-os-prod \
  --name workforce-os-production-runtime-v1 \
  --template-file deploy/azure-production-runtime-v1/main.bicep
```

After reviewed validation, replace `validate` with `create`. Only sanitized
resource IDs and FQDNs may be retained as evidence.
