import { isISO31661Alpha2 } from "class-validator";

export interface SenderIdentityReadiness {
  readonly physicalAddressSet: boolean;
  readonly senderNameSet: boolean;
  readonly countrySet: boolean;
}

/** Mirrors UpdateOrgDto's persisted sender-identity validation. */
export function senderIdentityReadiness(input: {
  readonly physicalAddress: string | null;
  readonly senderName: string | null;
  readonly country: string | null;
}): SenderIdentityReadiness {
  const physicalAddress = (input.physicalAddress ?? "").trim();
  const senderName = (input.senderName ?? "").trim();
  const country = (input.country ?? "").trim();

  return {
    physicalAddressSet: physicalAddress.length >= 5,
    senderNameSet: senderName.length > 0,
    countrySet:
      /^[A-Z]{2}$/.test(country) && isISO31661Alpha2(country),
  };
}
