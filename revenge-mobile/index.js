(function () {
    // We capture 'vendetta' from the wrapper scope: vendetta => { return ... }
    // This contains the scoped 'plugin' (storage) and 'logger'.

    // Safety check just in case
    const api = typeof vendetta !== "undefined" ? vendetta : window.vendetta;
    const { metro, logger, plugin, ui } = api;
    const { common } = metro;
    const { FluxDispatcher, React } = common;
    const { storage } = plugin;
    const { Forms } = ui.components;

    // --- Constants ---
    const LOG_PREFIX = "UniversalSyncLogger";
    const MAX_CACHE_SIZE = 500;

    // Variables
    const messageCache = new Map();
    let Unsubscribers = [];
    let MessageStore = metro.findByStoreName("MessageStore");
    let UserStore = metro.findByStoreName("UserStore");

    // Helpers
    const log = {
        info: (...args) => logger.info(`${LOG_PREFIX}:`, ...args),
        error: (...args) => logger.error(`${LOG_PREFIX}:`, ...args),
    };

    function cacheMessage(msg) {
        if (!msg?.id) return;

        if (messageCache.size > MAX_CACHE_SIZE) {
            const firstKey = messageCache.keys().next().value;
            if (firstKey) messageCache.delete(firstKey);
        }

        let attachments = [];
        if (msg.attachments) {
            if (Array.isArray(msg.attachments)) {
                attachments = msg.attachments;
            } else if (typeof msg.attachments.values === 'function') {
                attachments = Array.from(msg.attachments.values());
            }
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

        // Refresh store ref if needed
        if (!UserStore) UserStore = metro.findByStoreName("UserStore");
        const currentUser = UserStore?.getCurrentUser();

        const isBot = author.bot;
        const isSelf = currentUser && author.id === currentUser.id;

        if (storage.ignoreBots && isBot) return true;
        if (storage.ignoreSelf && isSelf) return true;
        return false;
    }

    async function sendLog(type, messageId, oldContent, newContent, author, channelId, attachments = []) {
        const url = storage.webhookUrl;
        if (!url || !url.startsWith("http")) return;

        let attachmentLinks = attachments.map(a => a.url || a.proxy_url).join("\n") || "";
        const attachmentText = attachmentLinks ? `\n\n**📎 Gelöschte Anhänge:**\n${attachmentLinks}` : "";

        const userField = author ? `${author.username}#${author.discriminator || '0000'}` : "Unbekannt";

        const embed = {
            title: type === "EDIT" ? "📱 ✏️ Bearbeitet (Handy)" : "📱 🗑️ Gelöscht (Handy)",
            color: type === "EDIT" ? 16753920 : 15158332,
            fields: [
                { name: "User", value: userField, inline: true },
                { name: "Kanal", value: `<#${channelId}>`, inline: true },
                { name: "Vorher", value: (oldContent || "*Nur Bild/Kein Text*") + attachmentText },
                { name: "Nachher", value: newContent || "*Wurde komplett gelöscht*" }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: `msgId:${messageId}|chId:${channelId}` }
        };

        try {
            await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ embeds: [embed] })
            });
        } catch (e) {
            log.error("Failed to send webhook", e);
        }
    }

    // Handlers
    const onMessageUpdate = (event) => {
        try {
            const { message } = event;
            if (!message || !message.id || !message.channel_id) return;

            if (!MessageStore) MessageStore = metro.findByStoreName("MessageStore");

            const storeMsg = MessageStore.getMessage(message.channel_id, message.id);
            const cached = messageCache.get(message.id);

            const oldContent = cached?.content ?? storeMsg?.content;
            const author = cached?.author ?? storeMsg?.author ?? message.author;
            const attachments = cached?.attachments ?? (storeMsg?.attachments ? Array.from(storeMsg.attachments) : []);

            if (!author) return;
            if (shouldIgnore(author)) return;

            if (message.content === undefined) return;

            const newContent = message.content;

            if (oldContent !== undefined && oldContent !== newContent) {
                sendLog("EDIT", message.id, oldContent, newContent, author, message.channel_id, attachments);
            }

            cacheMessage({ ...storeMsg, ...cached, ...message, author: author });
        } catch (e) {
            log.error("Error in onMessageUpdate", e);
        }
    };

    const onMessageDelete = (event) => {
        try {
            const { id, channelId } = event;
            if (!id || !channelId) return;

            if (!MessageStore) MessageStore = metro.findByStoreName("MessageStore");

            const storeMsg = MessageStore.getMessage(channelId, id);
            const cached = messageCache.get(id);

            const content = cached?.content ?? storeMsg?.content;
            const author = cached?.author ?? storeMsg?.author;
            const attachments = cached?.attachments ?? (storeMsg?.attachments ? Array.from(storeMsg.attachments) : []);

            if (!content && (!attachments || attachments.length === 0)) return;
            if (author && shouldIgnore(author)) return;

            sendLog("DELETE", id, content || "", "", author, channelId, attachments);

            messageCache.delete(id);
        } catch (e) {
            log.error("Error in onMessageDelete", e);
        }
    };

    const onMessageDeleteBulk = (event) => {
        const { ids, channelId } = event;
        if (!ids || !Array.isArray(ids)) return;
        ids.forEach(id => onMessageDelete({ id, channelId }));
    };

    const handleLateCache = (event) => {
        const msgs = event.messages || (event.message ? [event.message] : []);
        msgs.forEach(cacheMessage);
    };

    // Return the Plugin Object
    return {
        onLoad: () => {
            log.info("Plugin loading...");

            // Set defaults safely
            if (storage.webhookUrl === undefined) storage.webhookUrl = "";
            if (storage.ignoreSelf === undefined) storage.ignoreSelf = false;
            if (storage.ignoreBots === undefined) storage.ignoreBots = false;

            Unsubscribers = [
                FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate),
                FluxDispatcher.subscribe("MESSAGE_DELETE", onMessageDelete),
                FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", onMessageDeleteBulk),
                FluxDispatcher.subscribe("MESSAGE_CREATE", handleLateCache),
                FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", handleLateCache)
            ];

            log.info("Plugin loaded.");
        },
        onUnload: () => {
            Unsubscribers.forEach(unsub => unsub?.());
            Unsubscribers = [];
            messageCache.clear();
            log.info("Plugin unloaded.");
        },
        settings: () => {
            const { FormRow, TextInput, Switch } = Forms;

            const [webhookUrl, setWebhookUrl] = React.useState(storage.webhookUrl ?? "");
            const [ignoreSelf, setIgnoreSelf] = React.useState(storage.ignoreSelf ?? false);
            const [ignoreBots, setIgnoreBots] = React.useState(storage.ignoreBots ?? false);

            return React.createElement(React.Fragment, null,
                React.createElement(FormRow, {
                    label: "Webhook URL",
                    subLabel: "Discord Webhook URL for logging (Hidden)"
                }, React.createElement(TextInput, {
                    value: webhookUrl,
                    placeholder: "https://discord.com/api/webhooks/...",
                    onChange: (val) => {
                        setWebhookUrl(val);
                        storage.webhookUrl = val;
                    }
                })),
                React.createElement(FormRow, {
                    label: "Ignore Self",
                    subLabel: "Don't log your own edits/deletes",
                    control: React.createElement(Switch, {
                        value: ignoreSelf,
                        onValueChange: (val) => {
                            setIgnoreSelf(val);
                            storage.ignoreSelf = val;
                        }
                    })
                }),
                React.createElement(FormRow, {
                    label: "Ignore Bots",
                    subLabel: "Don't log bot edits/deletes",
                    control: React.createElement(Switch, {
                        value: ignoreBots,
                        onValueChange: (val) => {
                            setIgnoreBots(val);
                            storage.ignoreBots = val;
                        }
                    })
                })
            );
        }
    };
})()