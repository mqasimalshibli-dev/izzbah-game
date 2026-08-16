# Thawani merchant onboarding — information pack

Everything Thawani (or any Omani payment gateway) asks a merchant to supply,
pre-filled from what is verifiable in this repository and the live product.

**`[YOU]`** marks a field only you can supply — it is not guessable and must not
be invented. **Nothing here is signed or stamped.**

> This is an information pack, not Thawani's application form. Their form comes
> from them; copy these answers into it. The supporting documents in §6 are
> yours to publish and are ready to use.

---

## 1. Business details

| Field | Value |
|---|---|
| Trading name (Arabic) | عِزبة |
| Trading name (English) | Izzbah |
| Commercial Registration (CR) no. | **1669154** |
| Legal entity name | `[YOU]` — exactly as printed on the CR |
| Legal form | `[YOU]` (مؤسسة فردية / ش.م.م …) |
| CR issue / expiry date | `[YOU]` |
| Registered address | `[YOU]` |
| Governorate / Wilayat | `[YOU]` |
| VAT registration no. | `[YOU]` — or state "not registered" if below threshold |
| Chamber of Commerce membership no. | `[YOU]` |

## 2. Contact

| Field | Value |
|---|---|
| Authorised signatory | `[YOU]` — must match the CR |
| ID / passport no. | `[YOU]` |
| Mobile | `[YOU]` |
| Business email | izzbahgame@gmail.com |
| Support email (shown to customers) | izzbahgame@gmail.com |
| Technical contact | `[YOU]` |

## 3. Banking

| Field | Value |
|---|---|
| Bank name | `[YOU]` |
| Account name | `[YOU]` — must match the CR entity exactly |
| IBAN | `[YOU]` |
| Branch | `[YOU]` |

> The account name has to match the registered entity. A mismatch here is the
> most common cause of a rejected application.

## 4. The business

**What is sold.** عِزبة is an Arabic party trivia game played on one device by
two to five teams. It is free to try — every player gets one complete game at no
cost. After that, players buy **packs of games**: a one-time purchase of a fixed
number of plays, credited to their account.

**Digital goods only.** Nothing is shipped. There is no physical product, no
subscription billing today, and no recurring charge.

**Where it is sold.** https://izzbah.com — a web application. Native iOS and
Android builds are planned; those will use Apple / Google in-app purchase and
will not route through Thawani.

**Currency.** Omani Rial (OMR). Prices are final and shown inclusive.

**Price range.** `[YOU]` — confirm the current pack prices as listed in the app.

**Expected monthly volume.** `[YOU]` — Thawani asks for an estimate; give a
realistic launch figure rather than an aspirational one.

**Average transaction value.** `[YOU]`

**Customer base.** Oman, primarily; Arabic-speaking Gulf more broadly.

**Launched.** 2026 `[YOU]` — confirm the public launch date.

## 5. How a purchase works (for the technical section)

1. A signed-in player selects a pack in the app.
2. The app calls a Firebase Cloud Function (`createCheckout`) which records a
   **pending purchase** and returns a Thawani checkout session.
3. The player completes payment on Thawani's hosted checkout page.
4. Thawani calls our webhook (`paymentWebhook`). The callback signature is
   verified before anything is granted.
5. On a verified successful payment the games are credited **directly to the
   player's account** — no code is emailed, no manual step.
6. The player's balance updates on screen immediately.

**Security note for their form:** entitlements are written only by the backend
(Firebase Admin SDK). No client can grant itself games — the database rules deny
every user write to that collection. Payment status is never trusted from the
client.

**Integration status:** the backend is built and unit-tested. The one remaining
piece is Thawani's real signature verification, which is deliberately left
unimplemented until we have their documentation and keys — see
`PAYMENT_SETUP.md`.

**Callback URL:** `[YOU]` — the deployed `paymentWebhook` function URL.
**Success / cancel URLs:** https://izzbah.com

## 6. Supporting documents you must publish

Payment providers check that these exist and are reachable from the site before
approving. All three already exist in the app and are reproduced here as the
canonical text.

### 6.1 Refund and cancellation policy

> Game packs are a digital product. Once a pack has been activated and the games
> credited to an account, it is **non-refundable**.
>
> However — if you paid and did not receive your games, or you were charged
> incorrectly or twice, contact us within **7 days** at izzbahgame@gmail.com and
> we will correct it: either by crediting the games or refunding the amount.
>
> An order that has not yet been paid may be cancelled at any time by
> contacting us.

### 6.2 Delivery policy

> Delivery is immediate and electronic. Games are credited to the buyer's
> account as soon as payment is confirmed — usually within seconds. Nothing is
> posted or shipped. If games have not appeared within 30 minutes of a
> successful payment, contact izzbahgame@gmail.com.

### 6.3 Contact / customer service

> Email: izzbahgame@gmail.com
> Response time: within 2 business days.
> Language: Arabic and English.
> `[YOU]` — Thawani may require a phone number and a physical address here.

## 7. Documents Thawani will request from you

These come from authorities, your bank, or Thawani. I cannot produce any of
them and neither should anyone else.

- [ ] Commercial Registration certificate (copy)
- [ ] Chamber of Commerce certificate
- [ ] ID or passport of the authorised signatory
- [ ] Bank account confirmation / IBAN letter, in the entity's name
- [ ] VAT certificate, if registered
- [ ] Thawani's own merchant application form, completed and signed
- [ ] Signed merchant agreement

## 8. Before you submit — check these

- [ ] The account name on the IBAN letter **exactly** matches the CR entity name
- [ ] The refund, delivery and contact policies above are **live and linked**
      from izzbah.com, not only inside the app
- [ ] Prices shown on the site match what you declare on the form
- [ ] The site works and is publicly reachable — reviewers do open it
- [ ] The free game is playable without paying, so a reviewer can see the
      product before the paywall
