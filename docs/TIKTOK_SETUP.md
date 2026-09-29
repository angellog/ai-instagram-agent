# TikTok setup (Phase 0)

What you do once, outside the console, so Influencer OS can post to TikTok.
TikTok reviews the app (the audit) before posts can be public, so start this
first. Until the audit passes, everything the app posts is **private (only
visible to the account)**, which is fine for testing.

Your choices: photo posts first · both TikTok-native and adapted-from-Instagram
posts · Business accounts · media served from **salesgen.com**.

---

## 1. Serve images from salesgen.com

TikTok only fetches images from a domain you've verified, and it doesn't follow
redirects. The console serves each TikTok image itself at
`https://media.salesgen.com/tiktok-media/…`.

1. **Railway:** open the project → **web** service → Settings → Networking → **Custom domain** → add `media.salesgen.com`. Railway shows a CNAME target.
2. **DNS** (wherever salesgen.com is managed): add that **CNAME** record for `media`. Wait until Railway shows the domain as active (minutes to an hour).
3. **Console:** Config & keys → TikTok → **TikTok media base URL** = `https://media.salesgen.com`.

## 2. Create the TikTok developer app

1. Go to **developers.tiktok.com**, log in, and create an **app** (organization or individual). Name it "Influencer OS" and give it a description.
2. Add products:
   - **Login Kit**: redirect URI `https://web-production-2a489.up.railway.app/admin/tiktok/callback`. If you later move the console to your own domain, add that one too.
   - **Content Posting API**: turn on **Direct Post**.
3. Scopes to request: `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.publish`, `video.upload`.
4. **Verify salesgen.com.** Under the app's URL properties, add **Domain** `salesgen.com`. TikTok gives you a TXT value: add it as a **DNS TXT record** on salesgen.com, then press Verify. A verified domain covers `media.salesgen.com` too.
5. **Legal pages.** TikTok needs public Terms and Privacy URLs. The console serves them:
   - Terms: `https://media.salesgen.com/legal/terms`
   - Privacy: `https://media.salesgen.com/legal/privacy`

   Set the company name and contact email shown on them under Config & keys → TikTok.
6. Copy the app's **Client key** and **Client secret** into Config & keys → TikTok.

## 3. Prepare each influencer's TikTok account

1. Create the account in the TikTok app, one per influencer, with the same name and handle style as on Instagram.
2. Switch it to a **Business account**: Settings → Account → Switch to Business account. This is needed later for comment replies.
3. **Bio:** say it plainly. For example "AI creator · AI-generated photos · by FeetBit".
4. Turn on TikTok's **AI-generated content** setting for the account where the app offers it. The OS also sets `is_aigc` on every post.
5. Log into each account on your phone now and then and answer any security prompts, as you do for Instagram. Don't log into all of them from new devices at once.

## 4. Connect each account in the console

Pick the influencer in the sidebar → **Persona & soul → TikTok** → **Log in with TikTok**. Approve the permissions. The console shows the connected account and its privacy options.

## 5. Submit the app for audit

When at least one account is connected and a private test post has gone through:

1. In the developer portal, request **Content Posting API audit / production access**.
2. Include a short screen recording of the flow:
   1. connect the account
   2. a post waits in **Reviews**
   3. the TikTok settings (privacy chosen by you, AI label on)
   4. **Post now**
   5. the post appears on TikTok
3. Explain the use: *"An operator console for disclosed AI creator accounts. Every post is labelled AI-generated and reviewed by a human before it goes out."*
4. When TikTok approves it, set Config & keys → TikTok → **App audited** to `yes`. Posts can then be public.

## 6. Later (Phase 4): comment replies

Comment replies need the separate **TikTok API for Business** app and the **Accounts API access form** (required since March 2026). We'll do that once Phase 1–2 are running.

---

### If something goes wrong

- **"Private-only" posts after the audit:** check **App audited** is `yes` and each post's privacy isn't "Only me".
- **Image download failed:**
  - `media.salesgen.com` must be live on Railway.
  - salesgen.com must be verified in the developer portal.
  - The media base URL in Config must be exactly `https://media.salesgen.com`.
- **"Disconnected":** logins last 24 hours and renew automatically for a year. A red banner means TikTok ended the session: press **Log in with TikTok** again.
