import { definePlugin } from "@vencord/core";
import { FluxDispatcher, MessageStore } from "@webpack/common";

export default definePlugin({
    name: "UniversalSyncLogger",
    description: "Loggt Edits & Löschungen (inkl. Bilder) synchron zum Handy in einen Webhook.",
    authors: [{ name: "Sakashi", id: 0n }],

    // Einstellungsmenü für Vencord
    settings: {
        webhookUrl: {
            type: "string",
            default: "",
            description: "Füge hier die URL deines Discord-Webhooks ein.",
            name: "Webhook URL"
        }
    },

    start() {
        const sendLog = (type: "EDIT" | "DELETE", oldText: string, newText: string, author: any, channelId: string, attachments: any[] = []) => {
            const url = this.settings.store.webhookUrl;
            if (!url || !url.startsWith("https://discord.com/api/webhooks/")) return;

            // Bilder/Anhänge extrahieren
            let attachmentText = "";
            if (attachments && attachments.length > 0) {
                const links = attachments.map(a => a.url || a.proxy_url).join("\n");
                attachmentText = `\n\n**📎 Gelöschte Anhänge:**\n${links}`;
            }

            fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    embeds: [{
                        // Gleiches Design wie am Handy, aber mit PC-Markierung
                        title: type === "EDIT" ? "💻 ✏️ Bearbeitet (PC)" : "💻 🗑️ Gelöscht (PC)",
                        color: type === "EDIT" ? 16753920 : 15158332,
                        fields: [
                            { name: "User", value: `${author?.username || "Unbekannt"}`, inline: true },
                            { name: "Kanal", value: `<#${channelId}>`, inline: true },
                            { name: "Vorher", value: (oldText || "*Nur Bild/Kein Text*") + attachmentText },
                            { name: "Nachher", value: newText || "*Wurde komplett gelöscht*" }
                        ],
                        timestamp: new Date().toISOString(),
                        footer: { text: "Vencord Sync Plugin" }
                    }]
                })
            });
        };

        // Event-Handler für Bearbeitungen
        this.onMessageUpdate = (data: any) => {
            const message = data.message;
            if (!message || !message.id) return;

            const oldMessage = MessageStore.getMessage(message.channel_id, message.id);
            if (oldMessage && oldMessage.content !== undefined && oldMessage.content !== message.content) {
                sendLog("EDIT", oldMessage.content, message.content, oldMessage.author, message.channel_id, oldMessage.attachments);
            }
        };

        // Event-Handler für Löschungen
        this.onMessageDelete = (data: any) => {
            const oldMessage = MessageStore.getMessage(data.channelId, data.id);
            if (oldMessage) {
                sendLog("DELETE", oldMessage.content, "", oldMessage.author, data.channelId, oldMessage.attachments);
            }
        };

        // Abonnieren der Discord-Events
        FluxDispatcher.subscribe("MESSAGE_UPDATE", this.onMessageUpdate);
        FluxDispatcher.subscribe("MESSAGE_DELETE", this.onMessageDelete);
    },

    stop() {
        // Aufräumen beim Deaktivieren
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", this.onMessageUpdate);
        FluxDispatcher.unsubscribe("MESSAGE_DELETE", this.onMessageDelete);
    }
});