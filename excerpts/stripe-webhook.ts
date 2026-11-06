/**
 * Excerpt (simplified, comments translated) — Stripe webhook entry point and the
 * idempotent dispatcher.
 *
 * getStripe, serverEnv, getDb, nowIso and the per-event handlers are omitted.
 */
import { NextResponse } from "next/server";
import type Stripe from "stripe";

export async function POST(req: Request) {
  const stripe = getStripe();
  const secret = serverEnv.stripeWebhookSecret;
  if (!stripe || !secret) return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(await req.text(), sig, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
  try {
    const processed = await handleStripeEvent(event, stripe);
    return NextResponse.json({ received: true, duplicate: !processed });
  } catch {
    // 500 so Stripe retries; the event is not marked as successfully processed.
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

/** Returns false if the event was already processed (or is from the wrong mode). */
export async function handleStripeEvent(event: Stripe.Event, stripe: Stripe): Promise<boolean> {
  const db = await getDb();
  // Live key -> only live events, test key -> only test events.
  const expectLive = (serverEnv.stripeSecretKey ?? "").startsWith("sk_live_");
  if (typeof event.livemode === "boolean" && event.livemode !== expectLive) return false;

  if (await db.get("stripe_events", event.id)) return false;
  // Reserve the id BEFORE processing (primary key): two concurrent deliveries of the
  // same event cannot both get past this insert.
  try {
    await db.insert("stripe_events", { id: event.id, type: event.type, processedAt: nowIso() });
  } catch {
    return false;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        // Provisions only if the contract is already signed and Stripe reports a paid invoice;
        // runs under a DB lock; a second checkout for an active contract is cancelled + alerted.
        await onCheckoutCompleted(event.data.object as Stripe.Checkout.Session, stripe);
        break;
      case "invoice.paid":
        await onInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case "invoice.payment_failed":
        await onInvoiceFailed(event.data.object as Stripe.Invoice);
        break;
      // ...subscription updated/deleted, trial ending, disputes, refunds, etc.
    }
  } catch (e) {
    // Release the id so Stripe's retry (after our 500) processes it again; keep a trace of the error.
    await db.remove("stripe_events", event.id).catch(() => null);
    await db.insert("stripe_events", { id: `${event.id}:err:${Date.now()}`, type: event.type, processedAt: nowIso(), error: String(e).slice(0, 500) }).catch(() => null);
    throw e;
  }
  return true;
}
