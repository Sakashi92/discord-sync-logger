(function () {
    const VERSION = "1.8.0";
    const LOG_PREFIX = `UniversalSyncLogger V${VERSION}`;

    const api = typeof vendetta !== "undefined" ? vendetta : window.vendetta;
    const { metro, logger, plugin, ui, utils, patcher } = api;
    const { common } = metro;
    const { FluxDispatcher, React, ReactNative, moment } = common;
    const { storage } = plugin;

    const { View, Text, ScrollView, TouchableOpacity } = ReactNative;
    const { Forms, Button } = ui.components || {};
    const { showToast } = ui.toasts || {};

    const messageCache = new Map();
    let MessageStore = metro.findByStoreName("MessageStore");
    let UserStore = metro.findByStoreName("UserStore");
    let patches = [];

    // Cache for Webhook Channel ID to avoid fetching it every time
    let cachedLogChannelId = null;

    const log = {
        info: (...args) => logger.info(`${LOG_PREFIX}:`, ...args),
        error: (...args) => logger.error(`${LOG_PREFIX}:`, ...args),
    };

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    function toAnsi(text, type) {
        const bgCode = type === "DELETE" ? "41" : "43";
        return `\`\`\`ansi\n\u001b[0;${bgCode}m${text}\u001b[0m\n\`\`\``;
    }

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
            keys.sort();
            const toRemove = keys.slice(0, keys.length - 450);
            toRemove.forEach(k => delete storage.history[k]);
        }
    }

    function cacheMessage(msg) {
        if (!msg?.id) return;
        if (messageCache.size > 500) {
            const firstKey = messageCache.keys().next().value;
            if (firstKey) messageCache.delete(firstKey);
        }

        const historyContent = getHistory(msg.id);

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

    // --- Webhook / Remote Logic ---

    async function getLogChannelId(webhookUrl) {
        if (cachedLogChannelId) return cachedLogChannelId;
        try {
            const chRes = await fetch(webhookUrl.split("?")[0]);
            if (chRes.ok) {
                const chData = await chRes.json();
                if (chData.channel_id) {
                    cachedLogChannelId = chData.channel_id;
                    return cachedLogChannelId;
                }
            }
        } catch (e) { log.error("Failed to resolve webhook channel", e); }
        return null;
    }

    async function restoreFromWebhook(targetMessageIds) {
        if (!storage.webhookUrl || !targetMessageIds || targetMessageIds.length === 0) return;

        try {
            const TokenModule = metro.findByProps("getToken", "isTokenRequired");
            const token = TokenModule?.getToken?.();
            if (!token) return;

            const channelId = await getLogChannelId(storage.webhookUrl);
            if (!channelId) return;

            // Fetch recent logs (Limit 50 should cover recent context)
            const res = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages?limit=50`, {
                headers: { "Authorization": token }
            });

            if (!res.ok) return;
            const logs = await res.json();
            if (!Array.isArray(logs)) return;

            // Map: TargetMsgID -> Array of { oldContent, time }
            const restoredData = new Map();

            for (const logMsg of logs) {
                if (!logMsg.embeds) continue;
                for (const embed of logMsg.embeds) {
                    const footer = embed.footer?.text;
                    if (!footer || !footer.includes("id:")) continue;

                    const idMatch = footer.match(/id:\s*(\d+)/);
                    if (!idMatch) continue;
                    const logMsgId = idMatch[1];

                    // Check if this log belongs to a message we allow currently viewing
                    if (!targetMessageIds.includes(logMsgId)) continue;

                    // Check if it is an EDIT log
                    const isEdit = embed.title?.includes("✏️");
                    if (!isEdit) continue;

                    // Extract Old Content
                    // "Vorher" field
                    const prevField = embed.fields?.find(f => f.name === "Vorher");
                    if (prevField) {
                        const content = prevField.value;
                        const timestamp = logMsg.timestamp; // ISO string from log message
                        const timeStr = moment(timestamp).format("HH:mm:ss");

                        if (!restoredData.has(logMsgId)) restoredData.set(logMsgId, []);
                        restoredData.get(logMsgId).push({ content, timeStr, timestamp });
                    }
                }
            }

            // Apply restoration
            for (const [msgId, edits] of restoredData) {
                // Sort edits by time (oldest first)
                edits.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

                // Reconstruct ANSI History
                let combinedHistory = "";
                edits.forEach(e => {
                    // Check if this content is already in local history to avoid dupes?
                    // Hard to check string exact match without parsing ANSI.
                    // Simple heuristic: if local history is empty, restore full.
                    // If local history exists, assume it's accurate and skip? 
                    // Or try to merge?
                    // Risk of duplication.
                    // User asked to restore "if webhook is specified".
                    // Best approach: "Backfill".

                    const block = `${e.content}\n[${e.timeStr}]`;
                    combinedHistory += toAnsi(block, "EDIT");
                });

                const currentLocal = getHistory(msgId);
                // Only update if local is empty or significantly smaller?
                // Or if we trust remote more?
                // Let's assume if local is empty, we restore.

                if (!currentLocal && combinedHistory) {
                    saveHistory(msgId, combinedHistory);

                    // Dispatch update to UI to make it appear immediately
                    if (!MessageStore) MessageStore = metro.findByStoreName("MessageStore");
                    // We need channelId
                    const cached = messageCache.get(msgId);
                    if (cached) {
                        const msg = MessageStore.getMessage(cached.channelId, msgId);
                        if (msg) {
                            // Inject embed
                            const historyEmbed = {
                                type: "rich",
                                description: combinedHistory,
                                color: 0xFEE75C
                            };

                            const cleanEmbeds = (msg.embeds || []).filter(e => e.color !== 0xFEE75C);
                            const newEmbeds = [...cleanEmbeds, historyEmbed];

                            FluxDispatcher.dispatch({
                                type: "MESSAGE_UPDATE",
                                message: {
                                    ...msg,
                                    embeds: newEmbeds,
                                    __isGhost: true // Don't re-log this update!
                                }
                            });
                        }
                    }
                }
            }

        } catch (e) { log.error("Restoration failed", e); }
    }

    async function sendLog(type, messageId, oldContent, newContent, author, channelId, attachments = []) {
        const url = storage.webhookUrl;
        if (!url || !url.startsWith("http")) return;

        await sleep(2000); // Wait for potential deletion event

        // Check cache to see if we should skip logging (e.g. if we just deduped it)
        // isDuplicate calls fetch which is slow.
        // We can optimize next time.

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
            if (storage.history === undefined) storage.history = {};

            const unpatch = patcher.before("dispatch", FluxDispatcher, (args) => {
                const event = args[0];
                if (!event || !event.type) return;

                if (event.type === "LOAD_MESSAGES_SUCCESS") {
                    if (event.messages && Array.isArray(event.messages)) {
                        // 1. Restore Local
                        if (storage.editHistory) {
                            event.messages.forEach(msg => {
                                const savedHistory = getHistory(msg.id);
                                if (savedHistory) {
                                    if (!msg.embeds) msg.embeds = [];
                                    const cleanEmbeds = msg.embeds.filter(e => e.color !== 0xFEE75C);
                                    msg.embeds = [...cleanEmbeds, {
                                        type: "rich",
                                        description: savedHistory,
                                        color: 0xFEE75C
                                    }];
                                }
                                cacheMessage(msg);
                            });
                        } else {
                            event.messages.forEach(cacheMessage);
                        }

                        // 2. Restore Remote (Async Backfill)
                        if (storage.webhookUrl) {
                            const ids = event.messages.map(m => m.id);
                            restoreFromWebhook(ids);
                        }
                    }
                    return;
                }

                if (event.type === "MESSAGE_CREATE") {
                    if (event.message) cacheMessage(event.message);
                    return;
                }

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
                                type: "MESSAGE_EDIT_FAILED_AUTOMOD",
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

                if (event.type === "MESSAGE_UPDATE") {
                    try {
                        const { message } = event;
                        if (!message?.id || !message.content) return;
                        if (message.__isGhost) return; // Ignore our own updates

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
                                const prevHistory = cached?.historyContent || getHistory(message.id) || "";

                                const timeStr = moment().format("HH:mm:ss");
                                const contentWithTime = `${oldContent}\n[${timeStr}]`;

                                const ansiBlock = toAnsi(contentWithTime, "EDIT");
                                const newHistory = prevHistory + ansiBlock;

                                let embeds = message.embeds ? [...message.embeds] : [];
                                const cleanEmbeds = embeds.filter(e => e.color !== 0xFEE75C);
                                const historyEmbed = {
                                    type: "rich",
                                    description: newHistory,
                                    color: 0xFEE75C
                                };

                                event.message.embeds = [...cleanEmbeds, historyEmbed];

                                saveHistory(message.id, newHistory);

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