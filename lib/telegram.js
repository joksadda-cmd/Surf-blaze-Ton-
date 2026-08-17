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
export const PAYMENT_CHANNEL = '@YOUR_SURFBLAZE_PAYMENTS';  // ⚠️ REPLACE — proof-of-withdrawal posts go here
// Proof-of-payment banner image posted with every approved withdrawal
// (see api/bot.js wd_approve_). Swap for your own image whenever you have one.
export const PAYMENT_PROOF_PHOTO = 'https://cdn.phototourl.com/free/2026-08-07-562ff309-be9d-4683-974d-e5a27da44e18.png';
