import { esc } from "./html.js";

/**
 * Plain public Terms and Privacy pages for the platform apps' reviews (TikTok
 * requires both URLs). Deliberately short and factual about what the console
 * does with account data; the operator's company name and contact appear on both.
 */
export function legalPage(page: "terms" | "privacy", o: { company: string; email: string }): string {
  const c = esc(o.company);
  const contact = o.email ? `<a href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : "the operator";
  const updated = "29 September 2026";
  const body =
    page === "privacy"
      ? `<h1>Privacy Policy</h1><p class="m">Last updated ${updated}</p>
<p>${c} runs an operator console ("Influencer OS") for a small number of <b>openly AI creator accounts</b> on Instagram and TikTok. This policy explains what the console handles.</p>
<h2>What we store</h2><ul>
<li><b>Connected accounts:</b> for each creator account we connect, the account id, username, display name, avatar, follower counts and the access tokens the platform issues. Tokens are stored encrypted and used only to publish that account's posts and read its basic statistics.</li>
<li><b>Content:</b> the images and captions our creators publish, and their review and publishing history.</li>
<li><b>Comments and messages</b> sent to our creator accounts, where the platform allows replies: the text, the sender's public username and id, used only to reply and to remember context for that conversation. People can ask us to forget them at any time.</li></ul>
<h2>What we don't do</h2><ul><li>We don't sell data or share it with advertisers.</li><li>We don't post to any account except the creator accounts we operate.</li><li>We don't collect data from people who don't interact with our creator accounts.</li></ul>
<h2>Retention and deletion</h2><p>A creator account's stored tokens are deleted when we stop operating it or on request. Conversation memory expires automatically or on request. To ask for deletion or a copy of your data, contact ${contact}.</p>
<h2>AI disclosure</h2><p>Our creators are AI. Their photos are AI-generated and labelled as such on each post and in each profile.</p>`
      : `<h1>Terms of Service</h1><p class="m">Last updated ${updated}</p>
<p>These terms cover the use of the Influencer OS console and the creator accounts operated by ${c}.</p>
<ul>
<li>The console is operated by ${c} for its own creator accounts. It is not offered to the public.</li>
<li>Every creator we operate is openly AI: profiles say so and every post carries the platform's AI-generated label.</li>
<li>Posts are reviewed by a human operator or published under rules the operator sets; we follow each platform's community guidelines and terms.</li>
<li>We don't post on behalf of anyone else and don't impersonate real people.</li>
<li>Content is provided as is. For questions or takedown requests, contact ${contact}.</li></ul>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${page === "privacy" ? "Privacy Policy" : "Terms of Service"} · ${c}</title>
<style>body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:0 auto;padding:32px 20px;color:#1a1c22;background:#fff}h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px}.m{color:#666;margin:0 0 20px}a{color:#c8410e}</style>
</head><body>${body}<p class="m" style="margin-top:32px">${c}</p></body></html>`;
}
