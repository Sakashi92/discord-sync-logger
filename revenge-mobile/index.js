(function () {
    const VERSION = "1.0.8";
    const LOG_PREFIX = `UniversalSyncLogger V${VERSION}`;

    const api = typeof vendetta !== "undefined" ? vendetta : window.vendetta;
    const { metro, logger, plugin, ui, utils, navigation } = api;
    const { common } = metro;
    const { FluxDispatcher, React, ReactNative } = common;
    const { storage } = plugin;

    const { View, Text, ScrollView, TouchableOpacity } = ReactNative;
    const { Forms, Button } = ui.components || {};
    const { showToast } = ui.toasts || {};

    // --- State ---
    const messageCache = new Map();
    let MessageStore = metro.findByStoreName("MessageStore");
    let UserStore = metro.findByStoreName("UserStore");

    // Helpers
    const log = {
        info: (...args) => logger.info(`${LOG_PREFIX}:`, ...args),
        error: (...args) => logger.error(`${LOG_PREFIX}:`, ...args),
    };

    function cacheMessage(msg) {
        if (!msg?.id) return;
        if (messageCache.size > 500) {
            const firstKey = messageCache.keys().next().value;
            if (firstKey) messageCache.delete(firstKey);
        }
        let attachments = [];
        if (msg.attachments) {
            if (Array.isArray(msg.attachments)) attachments = msg.attachments;
            else if (typeof msg.attachments.values === 'function') attachments = Array.from(msg.attachments.values());
        }
        messageCache.set(msg.id, {
            content: msg.content ?? "",
            author: msg.author,
            channelId: msg.channel_id,
            attachments: attachments,
            timestamp: new Date()
        });
    }

    function shouldIgnore(author) {
        if (!author) return false;
        if (!UserStore) UserStore = metro.findByStoreName("UserStore");
        const currentUser = UserStore?.getCurrentUser();
        const isSelf = currentUser && author.id === currentUser.id;
        if (storage.ignoreBots && author.bot) return true;
        if (storage.ignoreSelf && isSelf) return true;
        return false;
    }

    async function sendLog(type, messageId, oldContent, newContent, author, channelId, attachments = []) {
        const url = storage.webhookUrl;
        if (!url || !url.startsWith("http")) return;

        const attachmentLinks = attachments.map(a => a.url || a.proxy_url).join("\n") || "";
        const attachmentText = attachmentLinks ? `\n\n**📎 Anhänge:**\n${attachmentLinks}` : "";
        const userField = author ? `${author.username}#${author.discriminator || '0000'}` : "Unbekannt";

        const embed = {
            title: type === "EDIT" ? `📱 ✏️ Bearbeitet (V${VERSION})` : `📱 🗑️ Gelöscht (V${VERSION})`,
            color: type === "EDIT" ? 16753920 : 15158332,
            fields: [
                { name: "User", value: userField, inline: true },
                { name: "Kanal", value: `<#${channelId}>`, inline: true },
                { name: "Vorher", value: (oldContent || "*Nur Bild/Kein Text*") + attachmentText },
                { name: "Nachher", value: newContent || "*Gelöscht*" }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: `id:${messageId}` }
        };

        try {
            const fetcher = utils?.safeFetch || fetch;
            await fetcher(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ embeds: [embed] })
            });
        } catch (e) {
            log.error("Webhook failed", e);
        }
    }

    // --- Handlers ---
    const onMessageUpdate = (event) => {
        try {
            const { message } = event;
            if (!message?.id) return;
            if (!MessageStore) MessageStore = metro.findByStoreName("MessageStore");
            const storeMsg = MessageStore.getMessage(message.channel_id, message.id);
            const cached = messageCache.get(message.id);
            const oldContent = cached?.content ?? storeMsg?.content;
            const author = cached?.author ?? storeMsg?.author ?? message.author;
            const attachments = cached?.attachments ?? (storeMsg?.attachments ? Array.from(storeMsg.attachments) : []);
            if (!author || shouldIgnore(author)) return;
            if (message.content === undefined) return;
            if (oldContent !== undefined && oldContent !== message.content) {
                sendLog("EDIT", message.id, oldContent, message.content, author, message.channel_id, attachments);
            }
            cacheMessage({ ...storeMsg, ...cached, ...message, author });
        } catch (e) { log.error("Update Error", e); }
    };

    const onMessageDelete = (event) => {
        try {
            const { id, channelId } = event;
            if (!id) return;
            if (!MessageStore) MessageStore = metro.findByStoreName("MessageStore");
            const storeMsg = MessageStore.getMessage(channelId, id);
            const cached = messageCache.get(id);
            const author = cached?.author ?? storeMsg?.author;
            if (!author || shouldIgnore(author)) return;
            const content = cached?.content ?? storeMsg?.content;
            const attachments = cached?.attachments ?? (storeMsg?.attachments ? Array.from(storeMsg.attachments) : []);
            if (!content && attachments.length === 0) return;
            sendLog("DELETE", id, content || "", "", author, channelId, attachments);
            messageCache.delete(id);
        } catch (e) { log.error("Delete Error", e); }
    };

    const onMessageDeleteBulk = (event) => {
        if (event.ids) event.ids.forEach(id => onMessageDelete({ id, channelId: event.channel_id }));
    };

    const onMessageCreate = (event) => {
        if (event.message) cacheMessage(event.message);
    };

    const onMessagesLoad = (event) => {
        if (event.messages) event.messages.forEach(cacheMessage);
    };

    // --- Plugin ---
    return {
        onLoad: () => {
            log.info("Loading V" + VERSION);
            if (storage.webhookUrl === undefined) storage.webhookUrl = "";
            if (storage.ignoreSelf === undefined) storage.ignoreSelf = false;
            if (storage.ignoreBots === undefined) storage.ignoreBots = false;

            FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
            FluxDispatcher.subscribe("MESSAGE_DELETE", onMessageDelete);
            FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", onMessageDeleteBulk);
            FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
            FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onMessagesLoad);

            if (showToast) showToast(`Sync Logger V${VERSION} Loaded`, 1);
        },
        onUnload: () => {
            FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onMessageUpdate);
            FluxDispatcher.unsubscribe("MESSAGE_DELETE", onMessageDelete);
            FluxDispatcher.unsubscribe("MESSAGE_DELETE_BULK", onMessageDeleteBulk);
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
            FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", onMessagesLoad);
            messageCache.clear();
            log.info("Unloaded.");
        },
        settings: () => {
            const [webhookUrl, setWebhookUrl] = React.useState(storage.webhookUrl ?? "");
            const [ignoreSelf, setIgnoreSelf] = React.useState(storage.ignoreSelf ?? false);
            const [ignoreBots, setIgnoreBots] = React.useState(storage.ignoreBots ?? false);

            const FormSection = Forms?.FormSection || View;
            const FormInput = Forms?.FormInput || Forms?.TextInput || ui.components?.TextInput || ReactNative.TextInput;
            const FormSwitch = Forms?.FormSwitch || ReactNative.Switch;

            const handleTextChange = (v) => {
                const text = typeof v === "string" ? v : (v?.nativeEvent?.text ?? "");
                setWebhookUrl(text);
                storage.webhookUrl = text;
            };

            const Row = ({ label, subLabel, control }) => (
                React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#333333" } },
                    React.createElement(View, { style: { flex: 1, marginRight: 10 } },
                        React.createElement(Text, { style: { color: "#ffffff", fontSize: 16, fontWeight: "bold" } }, label),
                        subLabel && React.createElement(Text, { style: { color: "#b9bbbe", fontSize: 13 } }, subLabel)
                    ),
                    control
                )
            );

            const SettingsButton = Button || TouchableOpacity;

            return React.createElement(ScrollView, { style: { flex: 1, padding: 15 } },
                React.createElement(FormSection, { title: "LOGGING CONFIGURATION" },
                    React.createElement(Text, { style: { color: "#ffffff", fontSize: 14, marginBottom: 8, fontWeight: "601" } }, "Webhook URL"),
                    React.createElement(FormInput, {
                        value: webhookUrl,
                        placeholder: "https://discord.com/api/webhooks/...",
                        onChangeText: handleTextChange,
                        onChange: handleTextChange,
                        style: !Forms?.FormInput ? { backgroundColor: "#202225", color: "white", padding: 10, borderRadius: 5 } : {}
                    }),
                    React.createElement(Text, { style: { color: "#72767d", fontSize: 11, marginTop: 5 } },
                        webhookUrl ? `Current: ${webhookUrl.substring(0, 40)}...` : "⚠️ No URL set - Logging disabled"
                    )
                ),

                React.createElement(View, { style: { marginTop: 20 } },
                    React.createElement(Row, {
                        label: "Ignore Self",
                        subLabel: "Don't log your own message edits/deletes",
                        control: React.createElement(FormSwitch, {
                            value: ignoreSelf,
                            onValueChange: (v) => { setIgnoreSelf(v); storage.ignoreSelf = v; }
                        })
                    }),
                    React.createElement(Row, {
                        label: "Ignore Bots",
                        subLabel: "Don't log bot messages",
                        control: React.createElement(FormSwitch, {
                            value: ignoreBots,
                            onValueChange: (v) => { setIgnoreBots(v); storage.ignoreBots = v; }
                        })
                    })
                ),

                React.createElement(View, { style: { marginTop: 30, marginBottom: 50 } },
                    React.createElement(SettingsButton, {
                        text: "Verlassen & Speichern", // Standard Button Prop
                        onPress: () => {
                            if (showToast) showToast("Einstellungen gespeichert", 1);
                            navigation?.pop?.(); // Try to close settings
                        },
                        style: !Button ? { backgroundColor: "#5865f2", padding: 15, borderRadius: 8, alignItems: "center" } : {}
                    }, !Button ? React.createElement(Text, { style: { color: "white", fontWeight: "bold" } }, "OK / Speichern") : null),

                    React.createElement(TouchableOpacity, {
                        style: { marginTop: 15, alignItems: "center" },
                        onPress: () => {
                            if (!webhookUrl) return showToast("Bitte erst URL eingeben", 0);
                            sendLog("TEST", "0", "Test Nachricht", "Test Erfolg!", null, "0");
                            showToast("Test-Log gesendet!", 1);
                        }
                    }, React.createElement(Text, { style: { color: "#5865f2", fontSize: 13 } }, "Test-Log senden"))
                ),

                React.createElement(Text, { style: { color: "#4f545c", textAlign: "center", fontSize: 11 } },
                    `UniversalSyncLogger V${VERSION}\nRevenge Mobile Port`
                )
            );
        }
    };
})()