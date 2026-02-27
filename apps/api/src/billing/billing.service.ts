import { Injectable } from "@nestjs/common";

@Injectable()
export class BillingService {
  getSubscription(orgId: string) {
    // TODO: Query Razorpay + local DB
    return { orgId, plan: "TRIAL", message: "Billing stub" };
  }

  subscribe(data: { orgId: string; plan: string }) {
    // TODO: Create Razorpay subscription
    return { ...data, message: "Subscription created stub" };
  }

  handleWebhook(body: unknown) {
    // TODO: Process Razorpay webhook events
    return { received: true };
  }
}
