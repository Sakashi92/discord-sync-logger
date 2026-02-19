(function () {
    const VERSION = "1.7.0";
    const LOG_PREFIX = `UniversalSyncLogger V${VERSION}`;

    const api = typeof vendetta !== "undefined" ? vendetta : window.vendetta;
    const { metro, logger, plugin, ui, utils, patcher } = api;
    const { common } = metro;
    const { FluxDispatcher, React, ReactNative, moment } = common;
    const { storage } = plugin;

    const { View, Text, ScrollView, TouchableOpacity } = ReactNative;
    const { Forms, Button } = ui.components || {};
    const { showToast } = ui.toasts || {};

    // Runtime Cache (for dedupe logic etc)
    const messageCache = new Map();
    let MessageStore = metro.findByStoreName("MessageStore");
    let UserStore = metro.findByStoreName("UserStore");
    let patches = [];

    const log = {
        info: (...args) => logger.info(`${LOG_PREFIX}:`, ...args),
        error: (...args) => logger.error(`${LOG_PREFIX}:`, ...args),
    };

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    function toAnsi(text, type) {
        const bgCode = type === "DELETE" ? "41" : "43";
        return `\`\`\`ansi\n\u001b[0;${bgCode}m${text}\u001b[0m\n\`\`\``;
    }

    // --- Persistence Helper ---
    function saveHistory(id, historyContent) {
        if (!storage.history) storage.history = {};
        storage.history[id] = historyContent;
        pruneHistory();
    }

    function getHistory(id) {
        if (!storage.history) return null;
        return storage.history[id] || null;
    }

    function pruneHistory() {
        if (!storage.history) return;
        const keys = Object.keys(storage.history);
        if (keys.length > 500) {
            // Sort by ID (Snowflake) - ascending (oldest first)
            // String comparison works for snowflakes of same length, but safe BigInt compare is better.
            // Simplified: String sort is "okay" for recent years. 
            // We strip the oldest ~50.
            keys.sort();
            const toRemove = keys.slice(0, keys.length - 450); // Keep 450
            toRemove.forEach(k => delete storage.history[k]);
        }
    }

    function cacheMessage(msg) {
        if (!msg?.id) return;
        if (messageCache.size > 500) {
            const firstKey = messageCache.keys().next().value;
            if (firstKey) messageCache.delete(firstKey);
        }

        // Try get history from Storage first, then Memory
        const historyContent = getHistory(msg.id); // Persistent

        let attachments = [];
        if (msg.attachments) {
            if (Array.isArray(msg.attachments)) attachments = msg.attachments;
            else if (typeof msg.attachments.values === 'function') attachments = Array.from(msg.attachments.values());
        }

        let cleanContent = msg.content ?? "";

        messageCache.set(msg.id, {
            content: cleanContent,
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

                    const idMatch = footer.match(/id:\s*(\d+)/);
                    if (!idMatch) continue;

                    const logMsgId = idMatch[1];
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
        const userField = author ? (author.discriminator === "0" ? author.username : `${author.username}#${author.discriminator || '0000'}`) : "Unbekannt";

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

    // --- Plugin ---
    return {
        onLoad: () => {
            log.info("Loading V" + VERSION);
            if (storage.webhookUrl === undefined) storage.webhookUrl = "";
            if (storage.ignoreSelf === undefined) storage.ignoreSelf = false;
            if (storage.ignoreBots === undefined) storage.ignoreBots = false;
            if (storage.showLoadToast === undefined) storage.showLoadToast = true;
            if (storage.noDelete === undefined) storage.noDelete = true;
            if (storage.editHistory === undefined) storage.editHistory = true;
            if (storage.history === undefined) storage.history = {}; // Init Storage

            const unpatch = patcher.before("dispatch", FluxDispatcher, (args) => {
                const event = args[0];
                if (!event || !event.type) return;

                // --- PERSISTENCE: INJECT HISTORY ON LOAD ---
                if (event.type === "LOAD_MESSAGES_SUCCESS") {
                    if (storage.editHistory && event.messages && Array.isArray(event.messages)) {
                        event.messages.forEach(msg => {
                            const savedHistory = getHistory(msg.id);
                            if (savedHistory) {
                                // Inject Embed
                                if (!msg.embeds) msg.embeds = [];

                                // Check (weakly) if we already have it to be safe
                                // But LOAD happens once usually per fetch.

                                const historyEmbed = {
                                    type: "rich",
                                    description: savedHistory,
                                    color: 0xFEE75C // Yellow
                                };

                                // Append
                                // Filter existing yellow embeds to avoid dupe on re-fetch?
                                const cleanEmbeds = msg.embeds.filter(e => e.color !== 0xFEE75C);
                                msg.embeds = [...cleanEmbeds, historyEmbed];
                            }
                            cacheMessage(msg);
                        });
                    } else if (event.messages) {
                        event.messages.forEach(cacheMessage);
                    }
                    return;
                }

                if (event.type === "MESSAGE_CREATE") {
                    if (event.message) cacheMessage(event.message);
                    return;
                }

                // --- DELETE INTERCEPTION ---
                if (event.type === "MESSAGE_DELETE") {
                    try {
                        const { id, channelId } = event;
                        if (!id) return;

                        const cached = messageCache.get(id);
                        const author = cached?.author;

                        if (!author || shouldIgnore(author)) return;

                        const content = cached?.content;
                        const attachments = cached?.attachments ?? [];
                        if (content || attachments.length > 0) {
                            sendLog("DELETE", id, content || "", "", author, channelId, attachments);
                        }

                        if (storage.noDelete && content) {
                            args[0] = {
                                type: "MESSAGE_EDIT_FAILED_AUTOMOD", // Red Native Background
                                messageData: {
                                    type: 1,
                                    message: {
                                        channelId: channelId,
                                        messageId: id,
                                    }
                                },
                                errorResponseBody: {
                                    code: 200000,
                                    message: "This message was deleted (UniversalSyncLogger)",
                                }
                            };
                            return args;
                        }

                        messageCache.delete(id);
                    } catch (e) { log.error("Delete Patch Error", e); }
                }

                // --- UPDATE INTERCEPTION ---
                if (event.type === "MESSAGE_UPDATE") {
                    try {
                        const { message } = event;
                        if (!message?.id || !message.content) return;

                        if (!MessageStore) MessageStore = metro.findByStoreName("MessageStore");
                        const storeMsg = MessageStore.getMessage(message.channel_id, message.id);
                        const cached = messageCache.get(message.id);

                        const oldContent = cached?.content ?? storeMsg?.content;
                        const author = cached?.author ?? storeMsg?.author ?? message.author;
                        const attachments = cached?.attachments ?? (storeMsg?.attachments ? Array.from(storeMsg.attachments) : []);

                        if (!author || shouldIgnore(author)) return;

                        if (oldContent !== undefined && oldContent !== message.content) {
                            sendLog("EDIT", message.id, oldContent, message.content, author, message.channel_id, attachments);

                            if (storage.editHistory) {
                                // Load saved history from storage if missing in cache (re-hydration)
                                const prevHistory = cached?.historyContent || getHistory(message.id) || "";

                                const timeStr = moment().format("HH:mm:ss");
                                const contentWithTime = `${oldContent}\n[${timeStr}]`;

                                const ansiBlock = toAnsi(contentWithTime, "EDIT");
                                const newHistory = prevHistory + ansiBlock;

                                let embeds = message.embeds ? [...message.embeds] : [];

                                const historyEmbed = {
                                    type: "rich",
                                    description: newHistory,
                                    color: 0xFEE75C
                                };

                                const cleanEmbeds = embeds.filter(e => e.color !== 0xFEE75C);
                                event.message.embeds = [...cleanEmbeds, historyEmbed];

                                // Save to Persistence
                                saveHistory(message.id, newHistory);

                                // Update Runtime Cache
                                messageCache.set(message.id, {
                                    content: message.content,
                                    author: author,
                                    channelId: message.channel_id,
                                    attachments: attachments,
                                    timestamp: new Date(),
                                    historyContent: newHistory
                                });
                            } else {
                                cacheMessage({ ...storeMsg, ...cached, ...message, author });
                            }
                        } else {
                            cacheMessage({ ...storeMsg, ...cached, ...message, author });
                        }
                    } catch (e) { log.error("Update Patch Error", e); }
                }
            });

            patches.push(unpatch);

            if (showToast && storage.showLoadToast) showToast(`Sync Logger V${VERSION} Loaded`, 1);
        },
        onUnload: () => {
            patches.forEach(p => p());
            patches = [];
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
                    React.createElement(Row, { label: "NoDelete", subLabel: "Prevent deletion (Native Red)", control: React.createElement(FormSwitch, { value: noDelete, onValueChange: (v) => { setNoDelete(v); storage.noDelete = v; } }) }),
                    React.createElement(Row, { label: "Edit History", subLabel: "Show Yellow ANSI History (Below)", control: React.createElement(FormSwitch, { value: editHistory, onValueChange: (v) => { setEditHistory(v); storage.editHistory = v; } }) }),
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