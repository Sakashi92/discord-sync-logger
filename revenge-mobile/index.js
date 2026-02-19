(function () {
    const VERSION = "1.0.7";
    const LOG_PREFIX = `UniversalSyncLogger V${VERSION}`;

    const api = typeof vendetta !== "undefined" ? vendetta : window.vendetta;
    const { metro, logger, plugin, ui, utils } = api;
    const { common } = metro;
    const { FluxDispatcher, React, ReactNative } = common;
    const { storage } = plugin;

    const { View, Text, ScrollView } = ReactNative;
    const { Forms } = ui.components || {};
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
        // ESSENTIAL: Check storage inside handler to ensure we use the newest setting
        const url = storage.webhookUrl;
        if (!url || !url.startsWith("http")) {
            // log.info("Webhook empty or invalid, skipping send.");
            return;
        }

        const attachmentLinks = attachments.map(a => a.url || a.proxy_url).join("\n") || "";
        const attachmentText = attachmentLinks ? `\n\n**📎 Anhänge:**\n${attachmentLinks}` : "";
        const userField = author ? `${author.username}#${author.discriminator || '0000'}` : "Unbekannt";

        const embed = {
            title: type === "EDIT" ? "📱 ✏️ Bearbeitet (V1.0.7)" : "📱 🗑️ Gelöscht (V1.0.7)",
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
            // Use safeFetch if available, else fetch
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
        if (event.ids) event.ids.forEach(id => onMessageDelete({ id, channelId: event.channelId }));
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
            log.info("Loading...");
            if (storage.webhookUrl === undefined) storage.webhookUrl = "";
            if (storage.ignoreSelf === undefined) storage.ignoreSelf = false;
            if (storage.ignoreBots === undefined) storage.ignoreBots = false;

            FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
            FluxDispatcher.subscribe("MESSAGE_DELETE", onMessageDelete);
            FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", onMessageDeleteBulk);
            FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
            FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onMessagesLoad);

            if (showToast) showToast(`Sync Logger V${VERSION} Loaded`, 1);
            log.info("Ready.");
        },
        onUnload: () => {
            // CRITICAL: Must use manual unsubscribe to prevent zombie plugins
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

            // Attempt to get Discord's specialized components
            const FormSection = Forms?.FormSection || View;
            const FormInput = Forms?.FormInput || Forms?.TextInput || ui.components?.TextInput || ReactNative.TextInput;
            const FormSwitch = Forms?.FormSwitch || ui.components?.FormSwitch || ReactNative.Switch;
            const FormText = Forms?.FormText || Text;

            const handleTextChange = (v) => {
                const text = typeof v === "string" ? v : (v?.nativeEvent?.text ?? "");
                setWebhookUrl(text);
                storage.webhookUrl = text;
            };

            return React.createElement(ScrollView, { style: { flex: 1, padding: 10 } },
                React.createElement(FormSection, { title: "Webhook Settings" },
                    React.createElement(FormText, { style: { color: "#b9bbbe", marginBottom: 5 } }, "Webhook URL:"),
                    React.createElement(FormInput, {
                        value: webhookUrl,
                        placeholder: "Enter URL...",
                        onChangeText: handleTextChange,
                        onChange: handleTextChange,
                        style: !Forms?.FormInput ? { backgroundColor: "#202225", color: "white", padding: 8, borderRadius: 4 } : {}
                    }),
                    React.createElement(FormText, { style: { color: "#72767d", fontSize: 10, marginTop: 4 } },
                        webhookUrl ? `Active: ${webhookUrl.substring(0, 30)}...` : "Empty (Logging disabled)"
                    )
                ),
                React.createElement(View, { style: { marginTop: 20 } }),
                React.createElement(FormSwitch, {
                    label: "Ignore Self",
                    note: "Don't log your own messages",
                    value: ignoreSelf,
                    onValueChange: (v) => { setIgnoreSelf(v); storage.ignoreSelf = v; }
                }),
                React.createElement(FormSwitch, {
                    label: "Ignore Bots",
                    note: "Don't log bot messages",
                    value: ignoreBots,
                    onValueChange: (v) => { setIgnoreBots(v); storage.ignoreBots = v; }
                }),
                React.createElement(Text, { style: { color: "#4f545c", textAlign: "center", marginTop: 20, fontSize: 12 } },
                    `Plugin Version: ${VERSION}\nIf settings don't apply, please Force Stop Discord.`
                )
            );
        }
    };
})()