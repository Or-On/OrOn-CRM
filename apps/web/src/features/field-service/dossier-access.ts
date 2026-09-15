import type { ServiceCaseDossier, ServiceCaseLinkCandidates } from "@or-on/crm";

/**
 * Field-service access does not imply permission to inspect retained calls.
 * Apply this at the server boundary before a dossier is rendered or serialized.
 */
export function dossierForVoiceAccess(
  dossier: ServiceCaseDossier,
  canReadVoice: boolean,
): ServiceCaseDossier {
  if (canReadVoice) return dossier;
  return {
    ...dossier,
    callSessionIds: [],
    calls: [],
    // Aggregate dossier summaries may incorporate call evidence. Without the
    // voice permission, expose only summaries whose provenance is explicitly
    // limited to the WhatsApp conversation.
    summaries: dossier.summaries.filter(
      (summary) => summary.sourceKind === "whatsapp",
    ),
  };
}

export function linkCandidatesForVoiceAccess(
  candidates: ServiceCaseLinkCandidates,
  canReadVoice: boolean,
): ServiceCaseLinkCandidates {
  return canReadVoice ? candidates : { ...candidates, calls: [] };
}
