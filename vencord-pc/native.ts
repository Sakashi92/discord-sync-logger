import { IpcMainInvokeEvent } from "electron";

export async function sendWebhookMessage(_: IpcMainInvokeEvent, url: string, jsonBody: string) {
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: jsonBody
        });

        const data = await res.text();
        return { status: res.status, data };
    } catch (e) {
        return { status: -1, data: String(e) };
    }
}

export async function getWebhookInfo(_: IpcMainInvokeEvent, webhookUrl: string) {
    try {
        // Webhook URL: https://discord.com/api/webhooks/{id}/{token}
        // GET without /messages etc. returns webhook info including channel_id
        const res = await fetch(webhookUrl.replace(/\/$/, ""), {
            method: "GET",
            headers: { "Content-Type": "application/json" }
        });
        const data = await res.json();
        return { status: res.status, channelId: data.channel_id ?? null, guildId: data.guild_id ?? null };
    } catch (e) {
        return { status: -1, channelId: null, guildId: null };
    }
}

export async function fetchChannelMessages(
    _: IpcMainInvokeEvent,
    token: string,
    channelId: string,
    limit: number,
    before?: string
) {
    try {
        let url = `https://discord.com/api/v9/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`;
        if (before) url += `&before=${before}`;

        const res = await fetch(url, {
            method: "GET",
            headers: {
                "Authorization": token,
                "Content-Type": "application/json"
            }
        });

        if (res.status !== 200) {
            const errText = await res.text();
            return { status: res.status, messages: [], error: errText };
        }

        const messages = await res.json();
        return { status: 200, messages, error: null };
    } catch (e) {
        return { status: -1, messages: [], error: String(e) };
    }
}
