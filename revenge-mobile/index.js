const { patcher, messages, settings, components } = enmity.api;
const { React } = enmity.modules.common;
const { TextInput, FormRow } = components;

const Patcher = patcher.create("universal-sync-mobile");

// Die Sende-Funktion
const sendLog = (type, oldText, newText, author, channelId, attachments) => {
    // Hier holen wir die URL live aus deinen Revenge-Einstellungen!
    const WEBHOOK_URL = settings.get("UniversalSyncLogger", "webhookUrl", "");

    // Stoppen, wenn kein gültiger Link eingetragen wurde
    if (!WEBHOOK_URL || !WEBHOOK_URL.startsWith("http")) return;

    let attachmentText = "";
    if (attachments && attachments.length > 0) {
        const links = attachments.map(a => a.url || a.proxy_url).join("\n");
        attachmentText = `\n\n**📎 Gelöschte Anhänge:**\n${links}`;
    }

    fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            embeds: [{
                title: type === "EDIT" ? "📱 ✏️ Bearbeitet (Handy)" : "📱 🗑️ Gelöscht (Handy)",
                color: type === "EDIT" ? 16753920 : 15158332,
                fields: [
                    { name: "User", value: `${author?.username || "Unbekannt"}`, inline: true },
                    { name: "Kanal", value: `<#${channelId}>`, inline: true },
                    { name: "Vorher", value: (oldText || "*Nur Bild/Kein Text*") + attachmentText },
                    { name: "Nachher", value: newText || "*Wurde komplett gelöscht*" }
                ],
                timestamp: new Date().toISOString()
            }]
        })
    });
};

export default {
    name: "UniversalSyncLogger",

    // 1. HIER WIRD DAS EINSTELLUNGSMENÜ FÜR DEIN HANDY GEBAUT
    getSettingsPanel() {
        return React.createElement(FormRow, {
            label: "Webhook URL",
            subLabel: "Trage hier deinen privaten Webhook-Link für die Logs ein."
        }, React.createElement(TextInput, {
            value: settings.get("UniversalSyncLogger", "webhookUrl", ""),
            onChange: (value) => settings.set("UniversalSyncLogger", "webhookUrl", value),
            placeholder: "https://discord.com/api/webhooks/..."
        }));
    },

    onStart() {
        // 2. Bearbeitungen abfangen
        Patcher.before(messages, "receiveMessage", ([, message]) => {
            if (message.type === "MESSAGE_UPDATE") {
                const oldMsg = messages.getMessage(message.channelId, message.id || message.message?.id);
                const newContent = message.message?.content;

                if (oldMsg && newContent !== undefined && oldMsg.content !== newContent) {
                    sendLog("EDIT", oldMsg.content, newContent, oldMsg.author, message.channelId, oldMsg.attachments);
                }
            }
        });

        // 3. Löschungen abfangen
        Patcher.before(messages, "deleteMessage", ([, info]) => {
            const deletedMsg = messages.getMessage(info.channelId, info.id);
            if (deletedMsg) {
                sendLog("DELETE", deletedMsg.content, "", deletedMsg.author, info.channelId, deletedMsg.attachments);
            }
        });
    },

    onStop() {
        Patcher.unpatchAll();
    }
};