import { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import { Tool, ToolContext, ToolResult } from "./tool.interface";
import { fetchWithRetry, withCircuitBreaker } from "../../common/http-retry.util";

type HubspotEntityType = "contact" | "deal" | "note";
type HubspotOperation = "create" | "update" | "delete";

/** Single helper to wrap every HubSpot REST call uniformly with retry + CB. */
function hubspotFetch(url: string, init: RequestInit): Promise<Response> {
  return withCircuitBreaker("hubspot", () =>
    fetchWithRetry(url, init, { provider: "hubspot" }),
  );
}

export class HubSpotTool implements Tool {
  name = "hubspot";
  description = "Interact with HubSpot CRM. Supports creating/updating contacts, searching contacts, creating deals, and logging activities.";
  parameters = {
    action: {
      type: "string",
      description: 'Action to perform: "create_contact", "update_contact", "search_contacts", "create_deal", "update_deal", "log_activity"',
      required: true,
    },
    data: {
      type: "object",
      description: "Data for the action (varies by action type)",
      required: true,
    },
  };

  constructor(private readonly evidenceLedger?: EvidenceLedgerService) {}

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const data = params.data as Record<string, unknown>;

    if (!action || !data) {
      return { success: false, data: null, error: "action and data are required" };
    }

    const creds = context.integrations.get("hubspot");

    if (creds?.accessToken && !creds.accessToken.startsWith("mock_")) {
      return this.executeReal(action, data, creds.accessToken, context);
    }

    return this.executeMock(action, data);
  }

  private async executeReal(
    action: string,
    data: Record<string, unknown>,
    accessToken: string,
    context: ToolContext,
  ): Promise<ToolResult> {
    const baseUrl = "https://api.hubapi.com";
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    try {
      switch (action) {
        case "create_contact": {
          const response = await hubspotFetch(`${baseUrl}/crm/v3/objects/contacts`, {
            method: "POST",
            headers,
            body: JSON.stringify({ properties: data }),
          });
          if (!response.ok) throw new Error(`HubSpot API error: ${response.status}`);
          const result = (await response.json()) as { id?: string };
          this.emitCrmSynced(context, {
            entityType: "contact",
            entityId: result.id,
            operation: "create",
            fieldsChanged: Object.keys(data),
          });
          return { success: true, data: { action: "contact_created", contact: result } };
        }
        case "update_contact": {
          const contactId = data.id as string;
          const properties = { ...data };
          delete properties.id;
          const response = await hubspotFetch(`${baseUrl}/crm/v3/objects/contacts/${contactId}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ properties }),
          });
          if (!response.ok) throw new Error(`HubSpot API error: ${response.status}`);
          const result = (await response.json()) as { id?: string };
          this.emitCrmSynced(context, {
            entityType: "contact",
            entityId: result.id ?? contactId,
            operation: "update",
            fieldsChanged: Object.keys(properties),
          });
          return { success: true, data: { action: "contact_updated", contact: result } };
        }
        case "search_contacts": {
          const response = await hubspotFetch(`${baseUrl}/crm/v3/objects/contacts/search`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              filterGroups: [
                {
                  filters: Object.entries(data).map(([key, value]) => ({
                    propertyName: key,
                    operator: "CONTAINS_TOKEN",
                    value,
                  })),
                },
              ],
              limit: 10,
            }),
          });
          if (!response.ok) throw new Error(`HubSpot API error: ${response.status}`);
          const result = (await response.json()) as { results: unknown[] };
          // search_contacts is a read; no crm.synced emission.
          return { success: true, data: { action: "contacts_found", contacts: result.results } };
        }
        case "create_deal": {
          const response = await hubspotFetch(`${baseUrl}/crm/v3/objects/deals`, {
            method: "POST",
            headers,
            body: JSON.stringify({ properties: data }),
          });
          if (!response.ok) throw new Error(`HubSpot API error: ${response.status}`);
          const result = (await response.json()) as { id?: string };
          this.emitCrmSynced(context, {
            entityType: "deal",
            entityId: result.id,
            operation: "create",
            fieldsChanged: Object.keys(data),
          });
          return { success: true, data: { action: "deal_created", deal: result } };
        }
        case "update_deal": {
          const dealId = data.id as string;
          const properties = { ...data };
          delete properties.id;
          const response = await hubspotFetch(`${baseUrl}/crm/v3/objects/deals/${dealId}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ properties }),
          });
          if (!response.ok) throw new Error(`HubSpot API error: ${response.status}`);
          const result = (await response.json()) as { id?: string };
          this.emitCrmSynced(context, {
            entityType: "deal",
            entityId: result.id ?? dealId,
            operation: "update",
            fieldsChanged: Object.keys(properties),
          });
          return { success: true, data: { action: "deal_updated", deal: result } };
        }
        case "log_activity": {
          const response = await hubspotFetch(`${baseUrl}/crm/v3/objects/notes`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              properties: {
                hs_note_body: data.note || data.body,
                hs_timestamp: new Date().toISOString(),
              },
            }),
          });
          if (!response.ok) throw new Error(`HubSpot API error: ${response.status}`);
          const result = (await response.json()) as { id?: string };
          this.emitCrmSynced(context, {
            entityType: "note",
            entityId: result.id,
            operation: "create",
            fieldsChanged: ["hs_note_body", "hs_timestamp"],
          });
          return { success: true, data: { action: "activity_logged", note: result } };
        }
        default:
          return { success: false, data: null, error: `Unknown action: ${action}` };
      }
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : "HubSpot API error",
      };
    }
  }

  /**
   * Fire-and-forget append to the evidence ledger. Only invoked when the real
   * HubSpot API returns 2xx — failures and mock responses never produce an
   * event. Missing ids fall back to a synthetic placeholder so the ref column
   * is never empty (downstream KPI joins require a non-null refId).
   */
  private emitCrmSynced(
    context: ToolContext,
    args: {
      readonly entityType: HubspotEntityType;
      readonly entityId: string | undefined;
      readonly operation: HubspotOperation;
      readonly fieldsChanged: readonly string[];
    },
  ): void {
    if (!this.evidenceLedger) return;
    const entityId = args.entityId && args.entityId.length > 0
      ? args.entityId
      : `hubspot:${args.entityType}:unknown:${Date.now()}`;
    void this.evidenceLedger.crmSynced({
      orgId: context.orgId,
      runId: context.runId ?? null,
      provider: "hubspot",
      entityType: args.entityType,
      entityId,
      operation: args.operation,
      fieldsChanged: args.fieldsChanged,
    });
  }

  private executeMock(action: string, data: Record<string, unknown>): ToolResult {
    const mockId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    switch (action) {
      case "create_contact":
        return {
          success: true,
          data: {
            action: "contact_created",
            mock: true,
            contact: {
              id: mockId,
              properties: {
                email: data.email || "contact@example.com",
                firstname: data.firstname || data.first_name || "John",
                lastname: data.lastname || data.last_name || "Doe",
                company: data.company || "Example Corp",
                ...data,
              },
              createdAt: new Date().toISOString(),
            },
          },
        };
      case "update_contact":
        return {
          success: true,
          data: {
            action: "contact_updated",
            mock: true,
            contact: { id: data.id || mockId, properties: data, updatedAt: new Date().toISOString() },
          },
        };
      case "search_contacts":
        return {
          success: true,
          data: {
            action: "contacts_found",
            mock: true,
            contacts: [
              { id: mockId, properties: { email: "john@example.com", firstname: "John", lastname: "Doe", company: "Example Corp" } },
            ],
          },
        };
      case "create_deal":
        return {
          success: true,
          data: {
            action: "deal_created",
            mock: true,
            deal: {
              id: mockId,
              properties: {
                dealname: data.dealname || data.name || "New Deal",
                amount: data.amount || 10000,
                dealstage: data.dealstage || "appointmentscheduled",
                ...data,
              },
              createdAt: new Date().toISOString(),
            },
          },
        };
      case "update_deal":
        return {
          success: true,
          data: {
            action: "deal_updated",
            mock: true,
            deal: { id: data.id || mockId, properties: data, updatedAt: new Date().toISOString() },
          },
        };
      case "log_activity":
        return {
          success: true,
          data: {
            action: "activity_logged",
            mock: true,
            note: { id: mockId, body: data.note || data.body, timestamp: new Date().toISOString() },
          },
        };
      default:
        return { success: false, data: null, error: `Unknown action: ${action}` };
    }
  }
}
