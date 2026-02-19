(function () {
    const VERSION = "1.3.1";
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

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    function cacheMessage(msg) {
        if (!msg?.id) return;
        if (messageCache.size > 500) {
            const firstKey = messageCache.keys().next().value;
            if (firstKey) messageCache.delete(firstKey);
        }

        const existing = messageCache.get(msg.id);
        const historyContent = existing?.historyContent || null;

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
            timestamp: new Date(),
            historyContent: historyContent
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

    // --- Deduplication Logic ---
    async function isDuplicate(webhookUrl, messageId, type) {
        try {
            const TokenModule = metro.findByProps("getToken", "isTokenRequired");
            const token = TokenModule?.getToken?.();
            if (!token) return false;

            const chRes = await fetch(webhookUrl.split("?")[0]);
            if (!chRes.ok) return false;
            const chData = await chRes.json();
            const channelId = chData.channel_id;
            if (!channelId) return false;

            const res = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages?limit=25`, {
                headers: { "Authorization": token }
            });
            if (!res.ok) return false;
            const messages = await res.json();
            if (!Array.isArray(messages)) return false;

            for (const msg of messages) {
                if (!msg.embeds?.length) continue;
                for (const embed of msg.embeds) {
                    const footer = embed.footer?.text;
                    if (!footer || !footer.includes("id:")) continue;

                    const logMsgId = footer.split("|")[0].replace("id:", "").trim();
                    const isEdit = embed.title?.includes("✏️");
                    const isDelete = embed.title?.includes("🗑️");
                    const logType = isEdit ? "EDIT" : (isDelete ? "DELETE" : null);

                    if (logMsgId === messageId && logType === type) {
                        return true;
                    }
                }
            }
        } catch (e) {
            log.error("Dedupe check failed", e);
        }
        return false;
    }

    async function sendLog(type, messageId, oldContent, newContent, author, channelId, attachments = []) {
        const url = storage.webhookUrl;
        if (!url || !url.startsWith("http")) return;

        await sleep(2000);

        const duplicate = await isDuplicate(url, messageId, type);
        if (duplicate) {
            log.info(`Skipped duplicate ${type} for ${messageId}`);
            return;
        }

        const attachmentLinks = attachments.map(a => a.url || a.proxy_url).join("\n") || "";
        const attachmentText = attachmentLinks ? `\n\n**📎 Anhänge:**\n${attachmentLinks}` : "";
        const userField = author ? `${author.username}#${author.discriminator || '0000'}` : "Unbekannt";

        const embed = {
            title: type === "EDIT" ? `📱 ✏️ Bearbeitet (Mobile)` : `📱 🗑️ Gelöscht (Mobile)`,
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
            if (message.__isGhost) return;

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

                if (storage.editHistory) {
                    const prevDisplay = cached?.historyContent || null;

                    // CLEANER STYLING: Quote + Strikethrough + Emoji
                    // "> ✏️ ~~Old Content~~"
                    let diffBlock = "";
                    const sanitizedOld = oldContent.replace(/\n/g, "\n> "); // Quote multilines

                    if (!prevDisplay) {
                        diffBlock = `> ✏️ ~~${sanitizedOld}~~\n`;
                    } else {
                        diffBlock = `${prevDisplay}> ✏️ ~~${sanitizedOld}~~\n`;
                    }

                    const newDisplay = `${diffBlock}${message.content}`;

                    setTimeout(() => {
                        FluxDispatcher.dispatch({
                            type: "MESSAGE_UPDATE",
                            message: {
                                ...message,
                                content: newDisplay,
                                __isGhost: true
                            }
                        });
                    }, 50);

                    messageCache.set(message.id, {
                        content: message.content,
                        author,
                        channelId: message.channel_id,
                        attachments,
                        timestamp: new Date(),
                        historyContent: newDisplay
                    });

                    return;
                }
            }
            cacheMessage({ ...storeMsg, ...cached, ...message, author });
        } catch (e) { log.error("Update Error", e); }
    };

    const onMessageDelete = (event) => {
        try {
            const { id, channelId } = event;
            if (!id) return;
            const cached = messageCache.get(id);
            const author = cached?.author;

            if (!author || shouldIgnore(author)) return;
            const content = cached?.content;
            const attachments = cached?.attachments ?? [];
            if (!content && attachments.length === 0) return;

            sendLog("DELETE", id, content || "", "", author, channelId, attachments);

            if (storage.noDelete && content) {
                let displayContent = cached.historyContent || content;
                let finalGhostContent = "";

                // Remove existing quotes? No, keep history.
                // Just wrap the "Current" (now deleted) in Strikethrough Quote.

                if (cached.historyContent) {
                    // historyContent ended with the *clean* content at the bottom.
                    // We need to find that clean content and wrap it.
                    // Simpler: Just append a "Deleted" marker?
                    // User wants to see the content.

                    // Since we appended `> ` for history, the "current" text has no quote.
                    // So we can assume the last part is the text.
                    // Let's just create a new block for simplicity.

                    // Actually, if we just want to mark it red/deleted, we can replae the WHOLE thing
                    // or just the last part.
                    // Let's replace the last part (current) with Strikethrough Quote.

                    // Ideally we would know what the "Current" part was.
                    // cached.content IS the clean current content!

                    const cleanCurrent = cached.content;
                    const cleanDisplay = `> 🗑️ ~~${cleanCurrent.replace(/\n/g, "\n> ")}~~`;

                    // We need to keep the OLD history blocks (which are already formatted)
                    // But `historyContent` INCLUDES the clean current at the end.
                    // So we have to strip it? That's risky.

                    // Let's just create a full history rebuild?
                    // We stored `historyContent` = `> Old \n Current`.
                    // We want `> Old \n > Deleted`.
                    // This is complex string manipulation.

                    // Alternative: Append `[GELÖSCHT]`
                    finalGhostContent = `${displayContent} \n# 🗑️ [GELÖSCHT]`;

                } else {
                    // No history, just one message.
                    finalGhostContent = `> 🗑️ ~~${content.replace(/\n/g, "\n> ")}~~`;
                }

                const ghostMsg = {
                    id: id,
                    channel_id: channelId,
                    author: author,
                    content: finalGhostContent,
                    timestamp: new Date().toISOString(),
                    state: "SENT",
                    __isGhost: true
                };

                setTimeout(() => {
                    FluxDispatcher.dispatch({
                        type: "MESSAGE_CREATE",
                        channelId: channelId,
                        message: ghostMsg,
                        optimistic: true
                    });
                }, 100);
            }

            messageCache.delete(id);
        } catch (e) { log.error("Delete Error", e); }
    };

    const onMessageDeleteBulk = (event) => {
        if (event.ids) event.ids.forEach(id => onMessageDelete({ id, channelId: event.channel_id }));
    };

    const onMessageCreate = (event) => { if (event.message && !event.message.__isGhost) cacheMessage(event.message); };
    const onMessagesLoad = (event) => { if (event.messages) event.messages.forEach(cacheMessage); };

    return {
        onLoad: () => {
            log.info("Loading V" + VERSION);
            if (storage.webhookUrl === undefined) storage.webhookUrl = "";
            if (storage.ignoreSelf === undefined) storage.ignoreSelf = false;
            if (storage.ignoreBots === undefined) storage.ignoreBots = false;
            if (storage.showLoadToast === undefined) storage.showLoadToast = true;
            if (storage.noDelete === undefined) storage.noDelete = true;
            if (storage.editHistory === undefined) storage.editHistory = true;

            FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
            FluxDispatcher.subscribe("MESSAGE_DELETE", onMessageDelete);
            FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", onMessageDeleteBulk);
            FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
            FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onMessagesLoad);

            if (showToast && storage.showLoadToast) showToast(`Sync Logger V${VERSION} Loaded`, 1);
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
            const [showLoadToast, setShowLoadToast] = React.useState(storage.showLoadToast ?? true);
            const [noDelete, setNoDelete] = React.useState(storage.noDelete ?? true);
            const [editHistory, setEditHistory] = React.useState(storage.editHistory ?? true);

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
                        style: !Forms?.FormInput ? { backgroundColor: "#202225", color: "white", padding: 10, borderRadius: 5 } : {}
                    }),
                    React.createElement(Text, { style: { color: "#72767d", fontSize: 11, marginTop: 5 } },
                        webhookUrl ? `Current: ${webhookUrl.substring(0, 40)}...` : "⚠️ No URL set - Logging disabled"
                    )
                ),

                React.createElement(View, { style: { marginTop: 20 } },
                    React.createElement(Row, { label: "NoDelete", subLabel: "Quote deleted messages", control: React.createElement(FormSwitch, { value: noDelete, onValueChange: (v) => { setNoDelete(v); storage.noDelete = v; } }) }),
                    React.createElement(Row, { label: "Edit History", subLabel: "Quote old edits", control: React.createElement(FormSwitch, { value: editHistory, onValueChange: (v) => { setEditHistory(v); storage.editHistory = v; } }) }),
                    React.createElement(Row, { label: "Ignore Self", subLabel: "Don't log own messages", control: React.createElement(FormSwitch, { value: ignoreSelf, onValueChange: (v) => { setIgnoreSelf(v); storage.ignoreSelf = v; } }) }),
                    React.createElement(Row, { label: "Ignore Bots", subLabel: "Don't log bot messages", control: React.createElement(FormSwitch, { value: ignoreBots, onValueChange: (v) => { setIgnoreBots(v); storage.ignoreBots = v; } }) }),
                    React.createElement(Row, { label: "Show Load Toast", subLabel: "Startup notification", control: React.createElement(FormSwitch, { value: showLoadToast, onValueChange: (v) => { setShowLoadToast(v); storage.showLoadToast = v; } }) })
                ),

                React.createElement(View, { style: { marginTop: 30, marginBottom: 50 } },
                    React.createElement(SettingsButton, {
                        text: "Verlassen & Speichern",
                        onPress: () => {
                            if (showToast) showToast("Settings saved", 1);
                            navigation?.pop?.();
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
                React.createElement(Text, { style: { color: "#4f545c", textAlign: "center", fontSize: 11 } }, `V${VERSION}`)
            );
        }
    };
})()