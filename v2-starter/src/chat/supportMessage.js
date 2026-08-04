/**
 * Hardcoded support copy — never from the model.
 *
 * SUPPORT_MESSAGE_HTML       — full block for type "support" (acute personal crisis).
 * SUPPORT_OFFER_FOOTER_HTML  — short footer when offerSupport: true (climate hopelessness
 *   without self-harm). Appended under the normal narrative.
 *
 * SAFETY: These constants are authored here and never contain model output or
 * user input. They are the ONLY strings in the chat path rendered via innerHTML
 * without escaping. Do not interpolate anything into them. Do not generate them.
 * Verify every resource before changing it — a wrong number is worse than none.
 * Last verified: 2026-08-03
 */

/** Full interstitial — shown alone when command.type === 'support'. */
export const SUPPORT_MESSAGE_HTML = `
<p>I'm not able to help with this, and I don't want to pretend otherwise — I'm a climate visualization tool.</p>
<p>If you're going through something hard, please reach out to someone you trust or a professional. If you're thinking about suicide in the US and Canada you can call or text <a href="tel:988" rel="noopener noreferrer">988</a>. Anywhere else, <a href="https://findahelpline.com" target="_blank" rel="noopener noreferrer">findahelpline.com</a> will point you to a service in your country.</p>
<p>You matter more than anything on this globe.</p>
`.trim();

/** Short footer only — shown under a normal narrative when offerSupport is true. */
export const SUPPORT_OFFER_FOOTER_HTML = `
<p>This subject is heavy, and it's totally okay to feel the weight of it. If it's sitting harder than usual, <a href="https://findahelpline.com" target="_blank" rel="noopener noreferrer">findahelpline.com</a> lists free support services in most countries.</p>
`.trim();
