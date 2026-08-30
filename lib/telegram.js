// lib/telegram.js
//
// সব জায়গায় (checkJoin, taskComplete, withdraw notification, admin bot)
// বারবার একই fetch কোড না লিখে এই helper গুলো শেয়ার করা হচ্ছে।

const BOT_TOKEN = process.env.BOT_TOKEN;

export async function tgApi(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json();
}

export const tgSend = (chatId, text, extra = {}) =>
    tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

export const tgEdit = (chatId, messageId, text, extra = {}) =>
    tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });

export const tgSendPhoto = (chatId, photo, caption, extra = {}) =>
    tgApi('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra });

// ⚠️ NEW — both COVER_PHOTO and PAYMENT_PROOF_PHOTO below are external
// hotlinked image URLs (free-tier hosts), not files uploaded to Telegram.
// tgApi() never throws on a Telegram-side error (sendPhoto just comes back
// with `ok:false` if the URL is dead/expired) — so a plain tgSendPhoto()
// call fails *silently*: no exception, no message, nothing. For COVER_PHOTO
// specifically that's every single new user's /start hitting a dead end
// with zero feedback. Use this instead of tgSendPhoto() anywhere the
// message MUST get through one way or another — it falls back to a
// text-only tgSend() with the same caption/buttons if the photo send fails.
export async function tgSendPhotoSafe(chatId, photo, caption, extra = {}) {
    const r = await tgApi('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra });
    if (r && r.ok) return r;
    return tgSend(chatId, caption, extra);
}

export const tgAnswerCallback = (callbackQueryId, text = '', showAlert = false) =>
    tgApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: showAlert });

// ⚠️ NEW — see the big comment above PAYMENT_PROOF_PHOTO / COVER_PHOTO
// below: both are external hotlink URLs, not Telegram file_ids, so they
// can (and eventually will) expire or get taken down by the free host.
// FIX WHEN YOU HAVE A MOMENT: send each image ONCE with tgSendPhoto to any
// chat, read `message.photo[...].file_id` back from the API response, and
// hardcode that file_id here instead of the URL — Telegram file_ids never
// expire, so this whole class of problem goes away for good.

// userId-কে CHANNEL/GROUP-এ মেম্বার কিনা চেক করে
export async function isMember(userId, chatUsername) {
    try {
        const r = await tgApi('getChatMember', { chat_id: chatUsername, user_id: userId });
        if (!r.ok) {
            // Telegram-এর আসল error message log করছি — bot admin থাকলেও fail হলে এখানেই কারণ দেখা যাবে
            // (যেমন: bot ওই chat-এ নেই, username ভুল, ইত্যাদি)
            console.error(`isMember(${userId}, ${chatUsername}) failed:`, r.description);
            return false;
        }
        return ['member', 'administrator', 'creator'].includes(r.result?.status);
    } catch (err) {
        console.error(`isMember(${userId}, ${chatUsername}) threw:`, err.message);
        return false; // Telegram API fail করলে ধরে নিন member না — fail-safe
    }
}

// ⚠️ These are all placeholders carried over from the NEWTUBE project —
// replace each with your real Surf Blaze channel/group @usernames once you
// create them (bot must be an admin of each for isMember() / posting to work):
export const OFFICIAL_CHANNEL = '@YOUR_SURFBLAZE_CHANNEL';  // ⚠️ REPLACE
export const COMMUNITY_GROUP = '@YOUR_SURFBLAZE_GROUP';     // ⚠️ REPLACE
export const PAYMENT_CHANNEL = '@YOUR_SURFBLAZE_PAYMENTS';  // ⚠️ REPLACE — proof-of-withdrawal posts go here
// Proof-of-payment banner image posted with every approved withdrawal
// (see api/bot.js wd_approve_). Swap for your own image whenever you have one.
// 🚨 EXPIRY RISK — this is a guest/anonymous upload on phototourl.com's
// FREE tier (note the "/free/" in the URL). Guest uploads on that kind of
// host typically auto-expire within about two weeks unless claimed with an
// account, so this link is likely to go dead soon, if it hasn't already.
// api/bot.js already falls back gracefully (posts a DM to the admin instead
// of silently failing) if this URL breaks, but the channel proof-post
// itself will stop showing an image until you replace it. See the
// tgSendPhotoSafe comment above for the permanent (file_id) fix.
export const PAYMENT_PROOF_PHOTO = 'https://cdn.phototourl.com/free/2026-08-07-562ff309-be9d-4683-974d-e5a27da44e18.png';
