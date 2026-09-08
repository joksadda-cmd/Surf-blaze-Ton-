// lib/telegram.js
//
// সব জায়গায় (checkJoin, taskComplete, withdraw notification, admin bot)
// বারবার একই fetch কোড না লিখে এই helper গুলো শেয়ার করা হচ্ছে।

import { APP_URL } from './constants.js';

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

// ⚠️ NEW — COVER_PHOTO (api/bot.js) and PAYMENT_PROOF_PHOTO (below) now
// point at your own self-hosted PNGs (cover.png / payment-proof.png at the
// project root — see api/bot.js's comment), not a third-party image host,
// so the expiry risk that motivated this helper is gone. It's kept as a
// defensive fallback anyway: tgApi() never throws on a Telegram-side error
// (sendPhoto just comes back with `ok:false`), so a plain tgSendPhoto()
// call fails *silently* if static hosting is ever down/misconfigured. Use
// this instead of tgSendPhoto() anywhere the message MUST get through one
// way or another — it falls back to a text-only tgSend() with the same
// caption/buttons if the photo send fails.
export async function tgSendPhotoSafe(chatId, photo, caption, extra = {}) {
    const r = await tgApi('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra });
    if (r && r.ok) return r;
    return tgSend(chatId, caption, extra);
}

export const tgAnswerCallback = (callbackQueryId, text = '', showAlert = false) =>
    tgApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: showAlert });

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

// Proof-of-payment banner image posted with every approved withdrawal
// (see api/bot.js wd_approve_). ✅ Self-hosted on your own Vercel domain —
// payment-proof.png is a generated water/sky-themed "PAYMENT SENT" banner
// served as a plain static file at the project root, same as cover.png
// (see api/bot.js) and index.html/game.html. No third-party image host
// involved anymore, so no expiry risk. Replace the PNG file directly if
// you ever want a different design — no code change needed.
export const PAYMENT_PROOF_PHOTO = `${APP_URL}/payment-proof.png`;
