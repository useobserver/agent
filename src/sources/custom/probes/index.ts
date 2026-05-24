// Customer custom-probe barrel.
//
// Add your custom probes as files in this directory and import them
// here so they register at agent boot. Each file calls
// `registerCustomProbe({ ... })` from "../registry".
//
// Example (see the docs guide for full examples):
//
//   // src/sources/custom/probes/stripe-webhooks.ts
//   import { registerCustomProbe } from "../registry.ts";
//   registerCustomProbe({
//     name: "stripe-webhook-delivery",
//     description: "Webhook delivery rate over the last 24h",
//     async run({ env }) {
//       const res = await fetch("https://api.stripe.com/v1/webhook_endpoints", {
//         headers: { Authorization: `Bearer ${env.STRIPE_API_KEY}` },
//       });
//       return computeDeliveryRate(await res.json());
//     },
//   });
//
// Then add: import "./stripe-webhooks.ts";
//
// This file ships empty: a fresh agent has no custom probes registered,
// so the Observer console shows the "no probes registered" empty state
// until you add one.

export {};
