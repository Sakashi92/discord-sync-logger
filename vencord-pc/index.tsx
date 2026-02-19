import "./deleteStyle.css";

import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { findByCodeLazy, findByProps } from "@webpack";
import { FluxDispatcher, MessageActions, MessageCache, MessageStore, Parser, SelectedChannelStore, Timestamp, UserStore, useStateFromStores } from "@webpack/common";

const Native = VencordNative.pluginHelpers.UniversalSyncLogger as PluginNative<typeof import("./native")>;
const logger = new Logger("UniversalSyncLogger");
const createMessageRecord = findByCodeLazy(".createFromServer(", ".isBlockedForMessage", "messageReference:");

const settings = definePluginSettings({
    webhookUrl: {
        type: OptionType.STRING,
        default: "",
        description: "Füge hier die URL deines Discord-Webhooks ein.",
        placeholder: "https://discord.com/api/webhooks/...",
    },
    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "Eigene Nachrichten ignorieren",
        default: false,
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Bot-Nachrichten ignorieren",
        default: false,
    },
});

// --- Eigener Cache für Webhook-Logging ---
const messageCache = new Map<string, { content: string; author: any; channelId: string; attachments: any[]; }>();
const MAX_CACHE_SIZE = 2000;

function cacheMessage(msg: any) {
    if (!msg?.id) return;
    messageCache.set(msg.id, {
        content: msg.content ?? "",
        author: msg.author,
        channelId: msg.channel_id,
        attachments: msg.attachments ? Array.from(msg.attachments) : [],
    });
    if (messageCache.size > MAX_CACHE_SIZE) {
        const firstKey = messageCache.keys().next().value;
        if (firstKey) messageCache.delete(firstKey);
    }
}

function cacheChannelMessages(channelId: string) {
    try {
        const messages = MessageStore.getMessages(channelId);
        if (messages?._array) {
            for (const msg of messages._array) {
                cacheMessage(msg);
            }
        }
    } catch { }
}

// --- Reconstruction: Persistente Zustände ---
interface ReconstructionEntry {
    type: "DELETE" | "EDIT";
    messageId: string;
    channelId: string;
    oldContent: string;
    newContent?: string;
    timestamp: string;
    author: string;
}

// Map<channelId, ReconstructionEntry[]> – Entries gruppiert nach Kanal
const reconstructionMap = new Map<string, ReconstructionEntry[]>();
const reconstructedChannels = new Set<string>(); // Kanäle die schon rekonstruiert wurden
let webhookChannelId: string | null = null;
let reconstructionLoaded = false;

// Webhook-Embeds parsen und reconstructionMap befüllen
function parseWebhookEmbeds(messages: any[]) {
    for (const msg of messages) {
        if (!msg.embeds?.length) continue;
        for (const embed of msg.embeds) {
            const footer = embed.footer?.text;
            if (!footer || !footer.startsWith("msgId:")) continue;

            // Footer Format: "msgId:<id>|chId:<channelId>"
            const parts = footer.split("|");
            const msgId = parts[0]?.replace("msgId:", "");
            const chId = parts[1]?.replace("chId:", "");
            if (!msgId || !chId) continue;

            const isEdit = embed.title?.includes("✏️");
            const isDelete = embed.title?.includes("🗑️");
            if (!isEdit && !isDelete) continue;

            // Felder auslesen
            const fields: Record<string, string> = {};
            for (const f of embed.fields ?? []) {
                fields[f.name] = f.value;
            }

            const entry: ReconstructionEntry = {
                type: isDelete ? "DELETE" : "EDIT",
                messageId: msgId,
                channelId: chId,
                oldContent: fields["Inhalt"]?.replace(/\n\n\*\*📎 Anhänge:\*\*\n[\s\S]*$/, "") ?? "",
                newContent: fields["Neu"],
                timestamp: embed.timestamp ?? msg.timestamp,
                author: fields["User"] ?? "Unbekannt",
            };

            if (!reconstructionMap.has(chId)) {
                reconstructionMap.set(chId, []);
            }
            reconstructionMap.get(chId)!.push(entry);
        }
    }
}

// Webhook-Channel auslesen und reconstructionMap aufbauen (max 500 Nachrichten = 5 Calls)
async function loadReconstructionData() {
    const url = settings.store.webhookUrl;
    if (!url) return;

    try {
        const info = await Native.getWebhookInfo(url.trim());
        if (info.status !== 200 || !info.channelId) {
            logger.error("❌ Webhook-Info konnte nicht geladen werden:", info);
            return;
        }
        webhookChannelId = info.channelId;
        logger.info("✅ Webhook-Channel:", webhookChannelId);

        // Token zur Laufzeit holen (nicht via lazy finder, da der beim Start noch nicht bereit ist)
        const TokenModule = findByProps("getToken", "isTokenRequired");
        const token = TokenModule?.getToken?.();
        if (!token) {
            logger.error("❌ Kein Token verfügbar für Reconstruction");
            return;
        }

        let allMessages: any[] = [];
        let before: string | undefined;
        const MAX_PAGES = 5; // 5 × 100 = 500 Nachrichten

        for (let i = 0; i < MAX_PAGES; i++) {
            const result = await Native.fetchChannelMessages(token, webhookChannelId!, 100, before);
            if (result.status !== 200 || !result.messages.length) break;

            allMessages = allMessages.concat(result.messages);
            before = result.messages[result.messages.length - 1].id;

            // Falls weniger als 100 → keine weiteren Seiten
            if (result.messages.length < 100) break;
        }

        logger.info(`📦 ${allMessages.length} Webhook-Nachrichten geladen für Reconstruction`);
        parseWebhookEmbeds(allMessages);
        reconstructionLoaded = true;
    } catch (e) {
        logger.error("❌ Reconstruction-Fehler:", e);
    }
}

// Reconstruction für einen bestimmten Kanal anwenden
function applyReconstruction(channelId: string) {
    if (!reconstructionLoaded) return;
    if (reconstructedChannels.has(channelId)) return;

    const entries = reconstructionMap.get(channelId);
    if (!entries?.length) {
        reconstructedChannels.add(channelId);
        return;
    }

    const messages = MessageStore.getMessages(channelId);
    if (!messages?._array?.length) {
        logger.info(`⏳ Kanal ${channelId}: Messages noch nicht im Store, retry später`);
        return;
    }

    logger.info(`🔄 Rekonstruiere ${entries.length} Einträge für Kanal ${channelId}`);
    let applied = 0;

    for (const entry of entries) {
        try {
            const existingMsg = messages._array.find((m: any) => m.id === entry.messageId);

            if (entry.type === "DELETE") {
                if (existingMsg && !existingMsg.deleted) {
                    // Nachricht existiert im Store → direkt als gelöscht markieren via MessageCache
                    const cache = MessageCache.getOrCreate(channelId);
                    if (cache.has(entry.messageId)) {
                        const newCache = cache.update(entry.messageId, (m: any) => m
                            .set("deleted", true)
                            .set("attachments", m.attachments.map((a: any) => (a.deleted = true, a))));
                        MessageCache.commit(newCache);
                        applied++;
                    }
                } else if (!existingMsg) {
                    // Nachricht nicht im Store → Ghost-Message via receiveMessage einfügen
                    // (gleicher Ansatz wie Vencord's commandHelpers.ts)
                    const fakeServerMsg = {
                        id: entry.messageId,
                        channel_id: channelId,
                        content: entry.oldContent || "*Gelöschte Nachricht*",
                        author: {
                            id: "0",
                            username: entry.author || "Unbekannt",
                            discriminator: "0000",
                            avatar: null,
                            bot: false,
                        },
                        timestamp: entry.timestamp,
                        edited_timestamp: null,
                        tts: false,
                        mention_everyone: false,
                        mentions: [],
                        mention_roles: [],
                        attachments: [],
                        embeds: [],
                        pinned: false,
                        type: 0,
                        flags: 0,
                    };

                    // createMessageRecord erstellt ein korrektes Discord-Message-Objekt
                    const ghostRecord = createMessageRecord(fakeServerMsg);
                    // receiveMessage fügt die Nachricht in den ChannelMessages-Cache ein
                    MessageActions.receiveMessage(channelId, ghostRecord);

                    // Jetzt als gelöscht markieren
                    const cache = MessageCache.getOrCreate(channelId);
                    if (cache.has(entry.messageId)) {
                        const newCache = cache.update(entry.messageId, (m: any) => m
                            .set("deleted", true)
                            .set("attachments", m.attachments.map((a: any) => (a.deleted = true, a))));
                        MessageCache.commit(newCache);
                    }
                    applied++;
                    logger.info(`👻 Ghost-Message eingefügt: ${entry.messageId}`);
                }
            } else if (entry.type === "EDIT" && existingMsg) {
                if (!existingMsg.editHistory?.some((e: any) => e.content === entry.oldContent)) {
                    const existingHistory = existingMsg.editHistory || [];
                    updateMessage(channelId, entry.messageId, {
                        editHistory: [...existingHistory, {
                            content: entry.oldContent,
                            timestamp: new Date(entry.timestamp)
                        }]
                    } as any);
                    applied++;
                }
            }
        } catch (e) {
            logger.error(`❌ Reconstruction-Fehler für ${entry.messageId}:`, e);
        }
    }

    reconstructedChannels.add(channelId);
    logger.info(`✅ Kanal ${channelId}: ${applied}/${entries.length} Einträge rekonstruiert`);

    // UI-Update triggern
    if (applied > 0) {
        MessageStore.emitChange();
    }
}


// --- Webhook ---
const sendLog = (url: string, type: "EDIT" | "DELETE", messageId: string, oldText: string, newText: string, author: any, channelId: string, attachments: any[] = []) => {
    if (!url || !url.includes("api/webhooks/")) return;

    let attachmentLinks = attachments?.map(a => a.url || a.proxy_url).join("\n") || "";
    const attachmentText = attachmentLinks ? `\n\n**📎 Anhänge:**\n${attachmentLinks}` : "";

    const body = JSON.stringify({
        embeds: [{
            title: type === "EDIT" ? "💻 ✏️ Bearbeitet (PC)" : "💻 🗑️ Gelöscht (PC)",
            color: type === "EDIT" ? 16753920 : 15158332,
            fields: [
                { name: "User", value: `${author?.username || "Unbekannt"}`, inline: true },
                { name: "Kanal", value: `<#${channelId}>`, inline: true },
                { name: "Inhalt", value: (oldText || "*Kein Text*") + attachmentText },
                ...(type === "EDIT" ? [{ name: "Neu", value: newText || "*Leergemacht*" }] : [])
            ],
            timestamp: new Date().toISOString(),
            footer: { text: `msgId:${messageId}|chId:${channelId}` }
        }]
    });

    Native.sendWebhookMessage(url.trim(), body).then(({ status, data }) => {
        if (status >= 200 && status < 300) {
            logger.info("✅ Webhook erfolgreich zugestellt!");
        } else {
            logger.error("❌ Webhook Fehler! Status:", status, "Details:", data);
        }
    }).catch(err => {
        logger.error("❌ Native Fehler:", err);
    });
};

// --- Flux Event Handler (für Webhook-Cache) ---
function handleCreate(event: any) {
    if (event.message) cacheMessage(event.message);
}

function handleUpdate(event: any) {
    if (!event.message) return;
    const old = messageCache.get(event.message.id);
    const storeMsg = MessageStore.getMessage(event.message.channel_id, event.message.id);
    const oldContent = old?.content ?? storeMsg?.content;

    if (oldContent !== undefined && event.message.content !== undefined && oldContent !== event.message.content) {
        const author = old?.author ?? storeMsg?.author;
        const attachments = old?.attachments ?? (storeMsg ? Array.from(storeMsg.attachments ?? []) : []);
        sendLog(settings.store.webhookUrl, "EDIT", event.message.id, oldContent, event.message.content, author, event.message.channel_id, attachments);
    }
    cacheMessage(event.message);
}

function handleLoadMessages(event: any) {
    if (event.messages) {
        for (const msg of event.messages) {
            cacheMessage(msg);
        }
    }
    // Reconstruction nach Nachrichten-Laden – das ist der zuverlässigste Zeitpunkt,
    // weil die Messages jetzt garantiert im Store sind
    if (event.channelId && reconstructionLoaded) {
        // Kurzer Delay damit der Store den Commit abschließt
        setTimeout(() => applyReconstruction(event.channelId), 100);
    }
}

function handleConnectionOpen() {
    // Bei jedem (Re-)Connect alles frisch laden
    reconstructionMap.clear();
    reconstructedChannels.clear();
    reconstructionLoaded = false;
    loadReconstructionData().catch(e => logger.error("Reconstruction fehlgeschlagen:", e));
}

function handleChannelSelect(event: any) {
    if (event.channelId) {
        cacheChannelMessages(event.channelId);
        // Lazy Reconstruction: Nur wenn der Kanal geöffnet wird
        if (reconstructionLoaded && !reconstructedChannels.has(event.channelId)) {
            // Kurz warten bis Messages geladen sind
            setTimeout(() => applyReconstruction(event.channelId), 500);
        }
    }
}

// --- Helper: Edit-Content parsen ---
function parseEditContent(content: string, message: Message) {
    return Parser.parse(content, true, {
        channelId: message.channel_id,
        messageId: message.id,
        allowLinks: true,
        allowHeading: true,
        allowList: true,
        allowEmojiLinks: true,
        viewingChannelId: SelectedChannelStore.getChannelId(),
    });
}

export default definePlugin({
    name: "UniversalSyncLogger",
    description: "Loggt Edits & Löschungen in einen Webhook, zeigt gelöschte Nachrichten rot und Edit-History im Chat an. Überlebt Neustarts.",
    authors: [{ name: "Sakashi", id: 0n }],
    settings,

    start() {
        FluxDispatcher.subscribe("MESSAGE_CREATE", handleCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", handleUpdate);
        FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", handleLoadMessages);
        FluxDispatcher.subscribe("CHANNEL_SELECT", handleChannelSelect);

        // Reconstruction erst starten wenn Discord komplett geladen ist
        FluxDispatcher.subscribe("CONNECTION_OPEN", handleConnectionOpen);
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleCreate);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", handleUpdate);
        FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", handleLoadMessages);
        FluxDispatcher.unsubscribe("CHANNEL_SELECT", handleChannelSelect);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", handleConnectionOpen);
        messageCache.clear();
        reconstructionMap.clear();
        reconstructedChannels.clear();
        webhookChannelId = null;
        reconstructionLoaded = false;
    },

    shouldIgnore(message: any, isEdit = false) {
        const { ignoreBots, ignoreSelf } = settings.store;
        const myId = UserStore.getCurrentUser()?.id;
        return (ignoreBots && message.author?.bot) ||
            (ignoreSelf && message.author?.id === myId);
    },

    makeEdit(newMessage: any, oldMessage: any): any {
        return {
            timestamp: new Date(newMessage.edited_timestamp),
            content: oldMessage.content
        };
    },

    renderEdits: ErrorBoundary.wrap(({ message: { id: messageId, channel_id: channelId } }: { message: Message; }) => {
        const message = useStateFromStores(
            [MessageStore],
            () => MessageStore.getMessage(channelId, messageId) as any,
            null,
            (oldMsg, newMsg) => oldMsg?.editHistory === newMsg?.editHistory
        );

        if (!message?.editHistory?.length) return null;

        return (
            <>
                {message.editHistory.map((edit: any, idx: number) => (
                    <div key={idx} className="usl-edited">
                        {parseEditContent(edit.content, message)}
                        <Timestamp
                            timestamp={edit.timestamp}
                            isEdited={true}
                            isInline={false}
                        >
                            <span className="usl-edited-timestamp"> (bearbeitet)</span>
                        </Timestamp>
                    </div>
                ))}
            </>
        );
    }, { noop: true }),

    handleDelete(cache: any, data: { ids?: string[], id: string; uslDeleted?: boolean; channelId: string; }, isBulk: boolean) {
        try {
            if (cache == null || (!isBulk && !cache.has(data.id))) return cache;

            const mutate = (id: string) => {
                const msg = cache.get(id);
                if (!msg) return;

                const EPHEMERAL = 64;
                const shouldRemove = data.uslDeleted ||
                    (msg.flags & EPHEMERAL) === EPHEMERAL ||
                    this.shouldIgnore(msg);

                if (shouldRemove) {
                    cache = cache.remove(id);
                } else {
                    const cached = messageCache.get(id);
                    sendLog(
                        settings.store.webhookUrl, "DELETE", id,
                        cached?.content ?? msg.content ?? "",
                        "",
                        cached?.author ?? msg.author,
                        data.channelId,
                        cached?.attachments ?? (msg.attachments ? Array.from(msg.attachments) : [])
                    );
                    messageCache.delete(id);

                    cache = cache.update(id, m => m
                        .set("deleted", true)
                        .set("attachments", m.attachments.map(a => (a.deleted = true, a))));
                }
            };

            if (isBulk) {
                data.ids!.forEach(mutate);
            } else {
                mutate(data.id);
            }
        } catch (e) {
            logger.error("Fehler in handleDelete", e);
        }
        return cache;
    },

    patches: [
        {
            // MessageStore
            find: '"MessageStore"',
            replacement: [
                {
                    // MESSAGE_DELETE: deleted=true statt entfernen
                    match: /function (?=.+?MESSAGE_DELETE:(\i))\1\((\i)\){let.+?((?:\i\.){2})getOrCreate.+?}(?=function)/,
                    replace:
                        "function $1($2){" +
                        "   var cache = $3getOrCreate($2.channelId);" +
                        "   cache = $self.handleDelete(cache, $2, false);" +
                        "   $3commit(cache);" +
                        "}"
                },
                {
                    // MESSAGE_DELETE_BULK
                    match: /function (?=.+?MESSAGE_DELETE_BULK:(\i))\1\((\i)\){let.+?((?:\i\.){2})getOrCreate.+?}(?=function)/,
                    replace:
                        "function $1($2){" +
                        "   var cache = $3getOrCreate($2.channelId);" +
                        "   cache = $self.handleDelete(cache, $2, true);" +
                        "   $3commit(cache);" +
                        "}"
                },
                {
                    // Edit-History bei MESSAGE_UPDATE speichern
                    match: /(function (\i)\((\i)\).+?)\.update\((\i)(?=.*MESSAGE_UPDATE:\2)/,
                    replace: "$1" +
                        ".update($4,m =>" +
                        "   (($3.message.flags & 64) === 64 || $self.shouldIgnore($3.message, true)) ? m :" +
                        "   $3.message.edited_timestamp && $3.message.content !== m.content ?" +
                        "       m.set('editHistory',[...(m.editHistory || []), $self.makeEdit($3.message, m)]) :" +
                        "       m" +
                        ")" +
                        ".update($4"
                },
                {
                    // Gelöschte Nachrichten nicht per Tastatur bearbeitbar
                    match: /(?<=getLastEditableMessage\(\i\)\{.{0,200}\.find\((\i)=>)/,
                    replace: "!$1.deleted &&"
                }
            ]
        },
        {
            // Message Domain Model – deleted + editHistory Properties
            find: "}addReaction(",
            replacement: [
                {
                    match: /this\.customRenderedContent=(\i)\.customRenderedContent,/,
                    replace: "this.customRenderedContent=$1.customRenderedContent," +
                        "this.deleted=$1.deleted||false," +
                        "this.editHistory=$1.editHistory||[]," +
                        "this.firstEditTimestamp=$1.firstEditTimestamp||this.editedTimestamp||this.timestamp,"
                }
            ]
        },
        {
            // Message Transformer – deleted + editHistory durchreichen
            find: ".PREMIUM_REFERRAL&&(",
            replacement: [
                {
                    match: /(?<=null!=\i\.edited_timestamp\)return )\i\(\i,\{reactions:(\i)\.reactions.{0,50}\}\)/,
                    replace: "Object.assign($&,{deleted:$1.deleted,editHistory:$1.editHistory,firstEditTimestamp:$1.firstEditTimestamp})"
                },
                {
                    match: /attachments:(\i)\((\i)\)/,
                    replace:
                        "attachments:$1($2)," +
                        "deleted:arguments[1]?.deleted," +
                        "editHistory:arguments[1]?.editHistory," +
                        "firstEditTimestamp:new Date(arguments[1]?.firstEditTimestamp??$2.editedTimestamp??$2.timestamp)"
                }
            ]
        },
        {
            // Base Message Component – CSS-Klasse für gelöschte Nachrichten
            find: "Message must not be a thread starter message",
            replacement: [
                {
                    match: /\)\("li",\{(.+?),className:/,
                    replace: ")(\"li\",{$1,className:(arguments[0].message.deleted ? \"usl-deleted \" : \"\")+"
                }
            ]
        },
        {
            // Message Content Renderer – Edit-History vor dem Inhalt anzeigen
            find: ".SEND_FAILED,",
            replacement: {
                match: /\]:(\i)\.isUnsupported.{0,20}?,children:\[/,
                replace: "$&arguments[0]?.message?.editHistory?.length>0&&$self.renderEdits(arguments[0]),"
            }
        },
        {
            // ReferencedMessageStore – Antworten auf gelöschte Nachrichten behalten
            find: '"ReferencedMessageStore"',
            replacement: [
                {
                    match: /MESSAGE_DELETE:\i,/,
                    replace: "MESSAGE_DELETE:()=>{},"
                },
                {
                    match: /MESSAGE_DELETE_BULK:\i,/,
                    replace: "MESSAGE_DELETE_BULK:()=>{},"
                }
            ]
        },

    ]
});
