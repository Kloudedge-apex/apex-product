import { Injectable } from "@nestjs/common";

@Injectable()
export class AuthService {
  handleWebhook(body: unknown) {
    // TODO: Process Clerk webhook events
    // - user.created -> create User record
    // - organization.created -> create Org record
    return { received: true };
  }
}
