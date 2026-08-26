// lib/ipRegistry.js — SEASON 4: device-fingerprint-based one-account gate
// (raw IP retired as the primary key, kept only as a last-resort fallback)
//
// ⚠️ FIX — Season 3 keyed this purely by IP address. Bangladeshi mobile
// carriers (GP/Robi/Banglalink) run CGNAT: thousands of completely
// unrelated phones share the same public IP at the same time. That made
// this block trigger false positives for genuinely different people on
// genuinely different phones — exactly the "this isn't even my account"
// report that prompted this fix. The client already generates a device
// fingerprint (canvas+screen+timezone+locale hash, see
// generateDeviceFingerprint() in index.html) and sends it on every init —
// it just wasn't being used for this gate. Keying by fingerprint instead
// actually identifies the physical device, doesn't have the shared-IP
// false-positive problem, and matches the real rule being enforced here:
// "one account per phone", not "one account per IP".
//
// IP is kept ONLY as a fallback key for the rare case a fingerprint truly
// couldn't be generated client-side (crypto.subtle missing / ancient
// WebView) — better a rare IP-based false positive than letting the whole
// gate be skipped by anyone whose client happens to not support it.
//
// COLLECTION: ipRegistry  (name kept as-is — just a "one identity per
// device-or-IP key" registry now, renaming the collection isn't worth a
// migration)
//   { _id: "<fingerprint hash, or 'ip:<address>' as fallback>",
//     userId: "<current owner telegram id>", claimedAt: Date, lastSeenAt: Date }

// Vercel/most proxies put the real client IP first in x-forwarded-for.
// Fall back through the other common headers, then the raw socket as a last resort.
export function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
    return req.socket?.remoteAddress || 'unknown';
}

// Picks the registry key: the device fingerprint when it looks valid,
// otherwise an 'ip:'-prefixed fallback key (prefixed so it can never
// collide with a real fingerprint hash).
function registryKey(fingerprint, ip) {
    if (fingerprint && typeof fingerprint === 'string' && fingerprint.length >= 16) return fingerprint;
    if (ip && ip !== 'unknown') return `ip:${ip}`;
    return null;
}

// Returns { blocked: false } if this device/IP is free or already owned by userId.
// Returns { blocked: true, ownerId } if a DIFFERENT userId currently owns it.
// `key` is always returned too so callers can claim() without recomputing it.
export async function checkDevice(db, fingerprint, ip, userId) {
    const key = registryKey(fingerprint, ip);
    if (!key) return { blocked: false, key: null }; // never lock users out over a detection failure
    const entry = await db.collection('ipRegistry').findOne({ _id: key });
    if (!entry) return { blocked: false, unclaimed: true, key };
    if (entry.userId === userId) {
        // ⚠️ keep this device's TTL clock fresh while its real owner is
        // still actively using it. Fire-and-forget: never block the request
        // on this, and never let it affect the block/allow decision itself.
        db.collection('ipRegistry').updateOne({ _id: key }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
        return { blocked: false, key };
    }
    return { blocked: true, ownerId: entry.userId, key };
}

// First-time claim of a free device/IP key — does not touch balances.
export async function claimDevice(db, key, userId) {
    if (!key) return;
    await db.collection('ipRegistry').updateOne(
        { _id: key },
        { $set: { userId, claimedAt: new Date(), lastSeenAt: new Date() } },
        { upsert: true }
    );
}

// "Switch account" — force-claim a device/IP key already owned by someone
// else, at the cost of wiping the switching user's own balance. Reassigns
// the ipRegistry mapping to this user; the PREVIOUS owner's account is
// untouched (they just no longer own this particular key — if they show up
// on it again later they'll hit the same block from the other side).
export async function claimDeviceForUser(db, key, userId) {
    if (!key) return;
    await db.collection('ipRegistry').updateOne(
        { _id: key },
        { $set: { userId, claimedAt: new Date(), lastSeenAt: new Date() } },
        { upsert: true }
    );
    await db.collection('users').updateOne(
        { _id: userId },
        {
            $set: {
                dcBalance: 0,
                usdtBalance: 0,
                lifetimeDcEarned: 0,
                lastAccountSwitchAt: new Date(),
            },
            $inc: { accountSwitchCount: 1 },
        }
    );
}

// Public-safe snippet of the current owner's identity for the block screen —
// never leak balances or internal flags to the blocked visitor.
export async function getOwnerPublicInfo(db, ownerId) {
    const owner = await db.collection('users').findOne(
        { _id: ownerId },
        { projection: { firstName: 1, telegramUsername: 1 } }
    );
    if (!owner) return { id: ownerId, firstName: 'Unknown', telegramUsername: null };
    return { id: ownerId, firstName: owner.firstName || 'User', telegramUsername: owner.telegramUsername !== 'N/A' ? owner.telegramUsername : null };
}
