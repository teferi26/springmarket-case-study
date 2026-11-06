/**
 * Excerpt (simplified, comments translated) — the public Server Action that signs a
 * contract and hands back a Stripe Checkout URL.
 *
 * No session is needed: the caller proves ownership of the draft with a random
 * resume token, and the action is rate-limited per IP. loadDraft, finalizeSignature,
 * createCheckoutSession, rateLimit and ip() are omitted.
 */
import { z } from "zod";

const pngDataUrl = z.string().startsWith("data:image/png;base64,").max(800_000);

export const signContract = action(
  z.object({
    draftId: z.string(),
    resumeToken: z.string(),
    signatureDataUrl: pngDataUrl,
    typedName: z.string().trim().min(2).max(120),
    accepted: z.literal(true),
    signatureMode: z.enum(["drawn", "typed"]).optional(),
  }),
  async (input, session) => {
    if (!(await rateLimit(`sign:${await ip()}`, 10, 600_000))) throw new Error("Too many attempts. Wait a few minutes.");
    const draft = await loadDraft(input.draftId, input.resumeToken); // checks the resume token
    if (draft.status === "paid") throw new Error("This sign-up is already complete");

    // finalizeSignature:
    //  - refuses if the signer's email was not verified with an OTP (forced on in production)
    //  - re-renders the contract text on the server (never trusts the browser) and stores its SHA-256
    //  - records signer IP, user agent and timestamp, writes the audit log
    //  - stores the signed PDF and emails it to the signer
    const contract = await finalizeSignature({ draft, signatureDataUrl: input.signatureDataUrl, typedName: input.typedName, session });

    // Checkout in subscription mode, client_reference_id = contract id, created with a Stripe
    // idempotency key derived from the contract; the webhook provisions after payment.
    const { url } = await createCheckoutSession(contract.id, { cancelTo: "wizard" });
    return { contractId: contract.id, checkoutUrl: url };
  },
  { public: true },
);
